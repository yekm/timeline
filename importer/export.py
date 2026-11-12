"""Build the static catalogue from a completed Wikidata scan."""

import argparse
from collections import OrderedDict, defaultdict
from contextlib import closing
import json
import math
from pathlib import Path
import re
import sqlite3
import sys
from tempfile import TemporaryDirectory
from urllib.parse import quote


DEFAULT_CATEGORIES = Path(__file__).with_name("categories.json")
GENERATOR = "chronoscope-wikidata"
SLUG = re.compile(r"[a-z0-9]+(?:-[a-z0-9]+)*\Z")
LANGUAGE = re.compile(r"[a-z]{2,12}(?:-[a-z0-9]{2,12})*\Z")
LANGUAGE_NAMES = {
    "en": "English", "ru": "Русский", "de": "Deutsch", "fr": "Français",
    "es": "Español", "it": "Italiano", "pt": "Português", "uk": "Українська",
    "ja": "日本語", "zh": "中文", "ar": "العربية", "pl": "Polski",
}


def read_catalog(path):
    config = json.loads(path.read_text(encoding="utf-8"))
    categories = {}
    for category in config["categories"]:
        identifier = category["id"]
        if not SLUG.fullmatch(identifier) or identifier in categories:
            raise ValueError(f"Invalid or duplicate category: {identifier}")
        categories[identifier] = category
    for category in categories.values():
        parent = category.get("parent")
        seen = {category["id"]}
        while parent:
            if parent in seen or parent not in categories:
                raise ValueError(f"Invalid parent chain for {category['id']}")
            seen.add(parent)
            parent = categories[parent].get("parent")
    pinned = config.get("pinned", {})
    for tags in pinned.values():
        if set(tags) - categories.keys():
            raise ValueError("A pinned entry uses an undefined category")
    return categories, pinned


def descendants(connection, roots):
    if not roots:
        return {}
    values = ",".join("(?, ?)" for _ in roots)
    parameters = [value for root in roots for value in (root, root)]
    rows = connection.execute(f"""
        WITH RECURSIVE closure(root, qid) AS (
            VALUES {values}
            UNION
            SELECT closure.root, subclasses.child
            FROM closure JOIN subclasses ON subclasses.parent = closure.qid
        )
        SELECT root, qid FROM closure
    """, parameters)
    result = defaultdict(set)
    for root, qid in rows:
        result[qid].add(root)
    return result


class Catalog:
    def __init__(self, connection, path):
        self.connection = connection
        self.categories, self.pinned = read_catalog(path)
        self.occupation_roots = defaultdict(set)
        self.event_roots = defaultdict(set)
        self.field_rules = []
        for category in self.categories.values():
            tag = category["id"]
            for root in category.get("occupations", []):
                self.occupation_roots[root].add(tag)
            for root in category.get("types", []):
                self.event_roots[root].add(tag)
            for profession, field in category.get("occupationFields", []):
                self.field_rules.append((profession, field, tag))
        roots = self.occupation_roots.keys() | self.event_roots.keys()
        for profession, field, _ in self.field_rules:
            roots.update((profession, field))
        self.ancestors = descendants(connection, sorted(roots))
        self.priority = {tag: i for i, tag in enumerate(self.categories)}

    def other_occupation(self, qid):
        tag = f"occupation-{qid.lower()}"
        if tag not in self.categories:
            row = self.connection.execute(
                "SELECT labels FROM class_labels WHERE qid = ?", (qid,),
            ).fetchone()
            labels = json.loads(row[0]) if row else {}
            labels.setdefault("en", next(iter(labels.values()), qid))
            parent = self.categories["other-professions"]
            self.categories[tag] = {
                "id": tag, "label": labels, "parent": parent["id"],
            }
        return tag

    def tags_for(self, row):
        tags = set(self.pinned.get(row["qid"], []))
        if row["kind"] == "person":
            field_roots = set()
            if self.field_rules:
                for field in json.loads(row["fields"]):
                    field_roots.update(self.ancestors.get(field, ()))
            for occupation in json.loads(row["occupations"]):
                occupation_roots = self.ancestors.get(occupation, ())
                matches = set()
                for root in occupation_roots:
                    matches.update(self.occupation_roots.get(root, ()))
                for profession, field, tag in self.field_rules:
                    if profession in occupation_roots and field in field_roots:
                        matches.add(tag)
                if matches:
                    tags.update(matches)
                else:
                    tags.add(self.other_occupation(occupation))
        else:
            for event_type in json.loads(row["types"]):
                for root in self.ancestors.get(event_type, ()):
                    tags.update(self.event_roots.get(root, ()))

        # Keep the most specific configured category first for shard ownership and colour.
        def order(tag):
            depth = 0
            parent = self.categories[tag].get("parent")
            while parent:
                depth += 1
                parent = self.categories[parent].get("parent")
            return (tag == "key-events", tag.startswith("occupation-"), -depth,
                    self.priority.get(tag, len(self.priority)), tag)

        return sorted(tags, key=order)


def position_fields(row, *, prefer_bounds=False):
    start, end, point = row["start"], row["end"], row["point"]
    single_bound = (start is None) != (end is None)
    values = {}
    if start is not None and end is not None and start <= end:
        fields = [("start", "startLabel", start, row["start_label"]),
                  ("end", "endLabel", end, row["end_label"])]
    elif point is not None and not (prefer_bounds and single_bound):
        fields = [("point", "pointLabel", point, row["point_label"])]
    elif start is not None and end is None:
        fields = [("start", "startLabel", start, row["start_label"])]
    elif end is not None and start is None:
        fields = [("end", "endLabel", end, row["end_label"])]
    else:
        return None
    for key, label_key, value, label in fields:
        if not math.isfinite(value):
            return None
        values[key] = value
        if label:
            values[label_key] = label
    dates = [field[2] for field in fields]
    return values, min(dates), max(dates)


def localize(entry, language, sitelinks, labels, languages):
    article = sitelinks[language]
    url = f"https://{language}.wikipedia.org/wiki/{quote(article.replace(' ', '_'), safe='/():,')}"
    result = {**entry, "title": labels.get(language) or article, "url": url, "language": language}
    if language == "en":
        fallback_titles = {lang: labels[lang] for lang in languages
                           if lang != "en" and lang not in sitelinks and labels.get(lang)}
        if fallback_titles:
            result["titles"] = fallback_titles
    return result


class Shards:
    def __init__(self, directory, bucket_years, shard_items):
        self.directory = directory
        self.bucket_years = bucket_years
        self.shard_items = shard_items
        self.bucket_counts = defaultdict(int)
        self.files = set()
        self.open_files = OrderedDict()
        self.by_tag = defaultdict(dict)

    def append(self, entry, start, end):
        bucket = math.floor(start / self.bucket_years) * self.bucket_years
        key = (entry["language"], entry["tags"][0], bucket)
        index = self.bucket_counts[key]
        self.bucket_counts[key] += 1
        path = f"{key[0]}/{key[1]}/{bucket}-{index // self.shard_items}.json"
        stream = self.open_files.pop(path, None)
        if stream is None:
            if len(self.open_files) >= 48:
                self.open_files.popitem(last=False)[1].close()
            output = self.directory / path
            output.parent.mkdir(parents=True, exist_ok=True)
            stream = output.open("a", encoding="utf-8")
        self.open_files[path] = stream
        stream.write("[\n" if index % self.shard_items == 0 else ",\n")
        stream.write(json.dumps(entry, ensure_ascii=False, separators=(",", ":"), allow_nan=False))
        self.files.add(path)

        for tag in entry["tags"]:
            chunk = self.by_tag[tag].setdefault(path, {
                "from": start, "to": end, "path": path, "count": 0, "language": entry["language"],
            })
            chunk["from"] = min(chunk["from"], start)
            chunk["to"] = max(chunk["to"], end)
            chunk["count"] += 1

    def close(self):
        for stream in self.open_files.values():
            stream.close()
        self.open_files.clear()

    def finish(self):
        self.close()
        for path in self.files:
            with (self.directory / path).open("a", encoding="utf-8") as stream:
                stream.write("\n]\n")


def build_catalogue(connection, stage, args):
    connection.row_factory = sqlite3.Row
    metadata = dict(connection.execute("SELECT key, value FROM metadata"))
    partial = metadata.get("partial") == "true"
    if partial and not args.allow_partial:
        raise ValueError("Scan is partial. Use --allow-partial to export a smoke-test catalogue.")

    catalog = Catalog(connection, args.categories)
    shards = Shards(stage, args.bucket_years, args.shard_items)
    exported = defaultdict(int)
    try:
        for row in connection.execute("SELECT * FROM entities"):
            sitelinks = json.loads(row["sitelinks"])
            available = [language for language in args.languages if sitelinks.get(language)]
            if not available:
                continue
            tags = catalog.tags_for(row)
            if not tags:
                continue
            position = position_fields(row, prefer_bounds="wars" in tags and "battles" not in tags)
            if not position:
                continue
            values, start, end = position
            entry = {"id": row["qid"], "kind": row["kind"], **values, "tags": tags}
            parents = json.loads(row["part_of"])
            if parents:
                entry["parent"] = parents[0]
            labels = json.loads(row["labels"])
            for language in available:
                item = localize(entry, language, sitelinks, labels, args.languages)
                shards.append(item, start, end)
                exported[language] += 1
    finally:
        shards.close()
    shards.finish()

    manifest = {
        "version": 1, "generator": GENERATOR, "snapshot": metadata.get("snapshot", ""),
        "partial": partial, "epochs": "../epochs.json",
        "languages": [{"id": lang, "label": LANGUAGE_NAMES.get(lang, lang)} for lang in args.languages],
        "categories": [],
    }
    for tag, category in catalog.categories.items():
        public = {key: category[key] for key in ("id", "label", "color", "parent", "featured") if key in category}
        public["label"] = {lang: label for lang, label in public["label"].items() if lang in args.languages}
        public["chunks"] = sorted(shards.by_tag[tag].values(), key=lambda chunk: (chunk["from"], chunk["path"]))
        manifest["categories"].append(public)
    with (stage / "manifest.json").open("w", encoding="utf-8") as stream:
        json.dump(manifest, stream, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
        stream.write("\n")
    return exported, len(shards.files)


def publish(args):
    output = args.output.absolute()
    if output.is_symlink() or output.exists() and not output.is_dir():
        raise ValueError(f"Output must be a directory: {output}")
    if output.exists() and any(output.iterdir()):
        marker = output / "manifest.json"
        if not marker.is_file() or json.loads(marker.read_text(encoding="utf-8")).get("generator") != GENERATOR:
            raise ValueError(f"Refusing to replace unrelated directory: {output}")

    output.parent.mkdir(parents=True, exist_ok=True)
    with TemporaryDirectory(prefix=f".{output.name}-", dir=output.parent) as workspace:
        stage = Path(workspace) / "next"
        stage.mkdir()
        database = f"{args.database.resolve().as_uri()}?mode=ro"
        with closing(sqlite3.connect(database, uri=True)) as connection:
            exported, count = build_catalogue(connection, stage, args)
        size = sum(path.stat().st_size for path in stage.rglob("*.json"))
        if size > args.page_budget_mb * 1_000_000:
            raise ValueError(f"Catalogue is {size / 1_000_000:.1f} MB, above the {args.page_budget_mb} MB budget. "
                             "Export fewer languages or adjust the budget for a different host.")
        backup = Path(workspace) / "previous"
        try:
            if output.exists():
                output.rename(backup)
            stage.rename(output)
        except BaseException:
            if backup.exists() and not output.exists():
                backup.rename(output)
            raise
    by_language = ", ".join(f"{lang}: {exported[lang]:,}" for lang in args.languages)
    print(f"Exported {by_language} to {output} in {count:,} shards ({size / 1_000_000:.2f} MB).")


def positive_int(value):
    number = int(value)
    if number < 1:
        raise argparse.ArgumentTypeError("must be at least 1")
    return number


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("database", type=Path, help="SQLite file created by scan.py")
    parser.add_argument("output", type=Path, help="Catalogue directory, typically site/data")
    parser.add_argument("--categories", type=Path, default=DEFAULT_CATEGORIES)
    parser.add_argument("--languages", nargs="+", default=["en", "ru"], metavar="LANG")
    parser.add_argument("--bucket-years", type=positive_int, default=50)
    parser.add_argument("--shard-items", type=positive_int, default=2_000)
    parser.add_argument("--page-budget-mb", type=positive_int, default=900)
    parser.add_argument("--allow-partial", action="store_true")
    args = parser.parse_args()
    if any(not LANGUAGE.fullmatch(lang) for lang in args.languages):
        parser.error("languages must be lowercase Wikipedia language codes such as en or ru")
    args.languages = list(dict.fromkeys(["en", *args.languages]))
    try:
        publish(args)
    except (OSError, ValueError, KeyError, sqlite3.Error) as error:
        print(f"Export failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
