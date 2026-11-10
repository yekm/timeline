"""Read a Wikidata entity dump into the local timeline catalog database."""

import argparse
from contextlib import closing
from dataclasses import dataclass
from datetime import date
import gzip
import json
import os
from pathlib import Path
import re
import sqlite3
import sys
import tempfile
import time
import zlib


SCHEMA = """
CREATE TABLE entities (
    qid TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    start REAL,
    end REAL,
    point REAL,
    start_label TEXT,
    end_label TEXT,
    point_label TEXT,
    occupations TEXT NOT NULL,
    types TEXT NOT NULL,
    sitelinks TEXT NOT NULL,
    labels TEXT NOT NULL,
    fields TEXT NOT NULL,
    part_of TEXT NOT NULL
);
CREATE TABLE subclasses (
    child TEXT NOT NULL,
    parent TEXT NOT NULL,
    PRIMARY KEY (child, parent)
) WITHOUT ROWID;
CREATE TABLE class_labels (qid TEXT PRIMARY KEY, labels TEXT NOT NULL);
CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
"""

QID = re.compile(r"Q[1-9][0-9]*\Z")
WIKI_SITE = re.compile(r"([a-z0-9_]+)wiki\Z")
TIMESTAMP = re.compile(r"([+-])([0-9]{4,16})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})Z\Z")
OTHER_WIKIS = {
    "commons", "foundation", "incubator", "login", "mediawiki", "meta", "nostalgia",
    "office", "outreach", "sources", "species", "strategy", "test", "test2", "wikidata",
}
POINT_PROPERTIES = ("P585", "P575", "P1191", "P1619", "P577", "P571")


@dataclass(frozen=True, slots=True)
class TimelineDate:
    year: float
    label: str
    precision: int


def statement_values(claims, prop):
    for statement in claims.get(prop, []):
        if statement.get("rank") == "deprecated":
            continue
        value = statement.get("mainsnak", {}).get("datavalue", {}).get("value")
        if value is not None:
            yield statement, value


def item_values(claims, prop):
    items = set()
    for _, value in statement_values(claims, prop):
        if not isinstance(value, dict) or value.get("entity-type") != "item":
            continue
        qid = value.get("id")
        if qid is None and isinstance(value.get("numeric-id"), int):
            qid = f"Q{value['numeric-id']}"
        if isinstance(qid, str) and QID.fullmatch(qid):
            items.add(qid)
    return sorted(items)


def day_number(year, month, day, *, julian=False):
    """Return the Julian day number in either proleptic calendar."""
    shift = (14 - month) // 12
    year += 4800 - shift
    month += 12 * shift - 3
    days = day + (153 * month + 2) // 5 + 365 * year + year // 4
    if julian:
        return days - 32083
    return days - year // 100 + year // 400 - 32045


GREGORIAN_YEAR_ZERO = day_number(0, 1, 1)


def calendar_position(year, month, day, julian, seconds):
    if not 1 <= month <= 12 or not 1 <= day <= 31:
        return None
    next_year, next_month = (year + 1, 1) if month == 12 else (year, month + 1)
    days = day_number(year, month, day, julian=julian)
    if days >= day_number(next_year, next_month, 1, julian=julian):
        return None
    if julian:
        year = (days - GREGORIAN_YEAR_ZERO) * 400 // 146097
        if days >= day_number(year + 1, 1, 1):
            year += 1
        elif days < day_number(year, 1, 1):
            year -= 1
    first_day = day_number(year, 1, 1)
    return year + (days - first_day + seconds / 86400) / (day_number(year + 1, 1, 1) - first_day)


def read_time(value):
    if not isinstance(value, dict):
        return None
    precision = value.get("precision")
    if not isinstance(precision, int) or not 0 <= precision <= 14:
        return None
    stamp = value.get("time", "")
    match = TIMESTAMP.fullmatch(stamp) if isinstance(stamp, str) else None
    if not match:
        return None
    sign, raw_year, *components = match.groups()
    year = int(raw_year)
    if not year:
        return None
    bce = sign == "-"
    year_coordinate = 1 - year if bce else year
    suffix = " BCE" if bce else ""

    if precision < 9:
        if precision == 8:
            first = year // 10 * 10
            low, high = max(first, 1), first + 9
        elif precision in (6, 7):
            width = 10 ** (9 - precision)
            low = (year - 1) // width * width + 1
            high = low + width - 1
        else:
            return TimelineDate(year_coordinate, f"≈{year:,}{suffix}", precision)
        return TimelineDate(year_coordinate, f"{low}–{high}{suffix}", precision)

    if precision == 9:
        return TimelineDate(year_coordinate, f"{year}{suffix}", precision)

    month, day, hour, minute, second = map(int, components)
    julian = str(value.get("calendarmodel", "")).endswith("/Q1985786")
    label = f"{year:04d}-{month:02d}"
    if precision >= 11:
        label += f"-{day:02d}"
    if precision >= 12:
        label += f" {hour:02d}:00" if precision == 12 else f" {hour:02d}:{minute:02d}"
    if precision == 14:
        label += f":{second:02d}"
    if precision >= 12 and not (0 <= hour < 24 and 0 <= minute < 60 and 0 <= second < 60):
        return None
    seconds = hour * 3600 if precision >= 12 else 0
    seconds += minute * 60 if precision >= 13 else 0
    seconds += second if precision == 14 else 0
    position = calendar_position(year_coordinate, month, day if precision >= 11 else 1, julian, seconds)
    if position is None:
        return None
    if julian:
        suffix += " (Julian)"
    return TimelineDate(position, label + suffix, precision)


def date_value(claims, prop):
    best_date = None
    best_key = (-1, -1)
    for statement, value in statement_values(claims, prop):
        candidate = read_time(value)
        if candidate is None:
            continue
        key = (statement.get("rank") == "preferred", candidate.precision)
        if key > best_key:
            qualifiers = statement.get("qualifiers", {}).get("P1480", [])
            circa = any(
                snak.get("datavalue", {}).get("value", {}).get("id") == "Q5727902"
                for snak in qualifiers
            )
            if circa and not candidate.label.startswith("≈"):
                candidate = TimelineDate(candidate.year, "≈" + candidate.label, candidate.precision)
            best_date, best_key = candidate, key
    return best_date


def wikipedia_links(entity):
    result = {}
    for site, link in entity.get("sitelinks", {}).items():
        match = WIKI_SITE.fullmatch(site)
        if match and match[1] not in OTHER_WIKIS and link.get("title"):
            prefix = match[1]
            language = "be-tarask" if prefix == "be_x_old" else prefix.replace("_", "-")
            result[language] = link["title"]
    return result


def entity_labels(entity):
    return {language: label["value"] for language, label in entity.get("labels", {}).items() if label.get("value")}


def compact_json(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def candidate_row(entity, qid, claims, types):
    if not types:
        return None

    kind = "event"
    point = None
    occupations = []
    if "Q5" in types:
        kind = "person"
        occupations = item_values(claims, "P106")
        if not occupations:
            return None
        start = date_value(claims, "P569")
        end = date_value(claims, "P570")
    else:
        start = date_value(claims, "P580")
        end = date_value(claims, "P582")
        for prop in POINT_PROPERTIES:
            point = date_value(claims, prop)
            if point is not None:
                break

    if start and end and start.year > end.year:
        if start.year // 1 == end.year // 1 and min(start.precision, end.precision) < 11:
            end = TimelineDate(start.year, end.label, end.precision)
        else:
            # Keep a known anchor without representing contradictory dates as a duration.
            end = None
    if start is None and end is None and point is None:
        return None
    links = wikipedia_links(entity)
    if not links:
        return None
    return (
        qid, kind,
        start.year if start else None, end.year if end else None, point.year if point else None,
        start.label if start else None, end.label if end else None, point.label if point else None,
        compact_json(occupations), compact_json(types), compact_json(links), compact_json(entity_labels(entity)),
        compact_json(item_values(claims, "P101")), compact_json(item_values(claims, "P361")),
    )


def records(source):
    """Stream the official array format, with one entity per physical line."""
    opened = False
    closed = False
    previous_separator = None
    for number, raw in enumerate(source, 1):
        line = raw.strip()
        if not line:
            continue
        if closed:
            raise ValueError(f"unexpected content after the closing bracket on line {number}")
        if not opened:
            if line not in (b"[", b"[]"):
                raise ValueError(f"expected a Wikidata JSON array on line {number}")
            opened = True
            closed = line == b"[]"
            continue
        if line == b"]":
            if previous_separator:
                raise ValueError(f"unexpected trailing comma before line {number}")
            closed = True
            continue
        if previous_separator is False:
            raise ValueError(f"missing comma before line {number}")
        previous_separator = line.endswith(b",")
        try:
            entity = json.loads(line[:-1] if previous_separator else line)
        except (ValueError, UnicodeError) as error:
            raise ValueError(f"invalid JSON entity on line {number}: {error}") from error
        if not isinstance(entity, dict):
            raise ValueError(f"expected a JSON object on line {number}")
        yield entity, previous_separator
    if not closed:
        raise ValueError("the dump ended before the closing JSON bracket")


def snapshot_date(dump):
    match = re.search(r"(?:^|[-_])([0-9]{4})([0-9]{2})([0-9]{2})(?=[-_.]|$)", dump.name)
    if match:
        try:
            return date(*map(int, match.groups())).isoformat()
        except ValueError:
            pass
    return ""


def fill_database(connection, dump, limit):
    connection.executescript(SCHEMA)
    scanned = saved = 0
    partial = False
    started = time.monotonic()
    batch = []
    links = []
    labels = []

    def flush():
        nonlocal saved
        with connection:
            connection.executemany("INSERT INTO entities VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", batch)
            connection.executemany("INSERT INTO subclasses VALUES (?, ?)", links)
            connection.executemany("INSERT INTO class_labels VALUES (?, ?)", labels)
        saved += len(batch)
        batch.clear()
        links.clear()
        labels.clear()

    opener = gzip.open if dump.suffix.lower() == ".gz" else open
    with opener(dump, "rb") as source:
        for entity, has_more in records(source):
            scanned += 1
            qid = entity.get("id")
            if entity.get("type") == "item" and isinstance(qid, str) and QID.fullmatch(qid):
                claims = entity.get("claims", {})
                parents = item_values(claims, "P279")
                types = item_values(claims, "P31")
                links.extend((qid, parent) for parent in parents)
                if parents or "Q12737077" in types:
                    names = entity_labels(entity)
                    if names:
                        labels.append((qid, compact_json(names)))
                row = candidate_row(entity, qid, claims, types)
                if row:
                    batch.append(row)
            if len(batch) + len(links) + len(labels) >= 8192:
                flush()
            if scanned % 1_000_000 == 0:
                elapsed = time.monotonic() - started
                print(f"Scanned {scanned:,} entities, kept {saved + len(batch):,} in {elapsed:.0f}s", file=sys.stderr)
            if limit is not None and scanned >= limit and has_more:
                partial = True
                break

    flush()
    with connection:
        connection.executemany(
            "INSERT INTO metadata VALUES (?, ?)",
            [("snapshot", snapshot_date(dump)), ("partial", str(partial).lower()), ("scanned", str(scanned))],
        )
    return scanned, saved, partial


def scan(dump, database, limit=None):
    dump = Path(dump)
    database = Path(database)
    if limit is not None and limit < 1:
        raise ValueError("the limit must be a positive integer")
    if dump.resolve() == database.resolve() or (database.exists() and dump.samefile(database)):
        raise ValueError("the dump and database must be different files")
    database.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=f".{database.name}-", dir=database.parent) as directory:
        temporary = Path(directory) / "catalog.sqlite"
        with closing(sqlite3.connect(temporary)) as connection:
            result = fill_database(connection, dump, limit)
        os.replace(temporary, database)
    return result


def positive_int(value):
    number = int(value)
    if number < 1:
        raise argparse.ArgumentTypeError("must be a positive integer")
    return number


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("dump", type=Path, help="Wikidata entity dump (.json.gz or canonical .json)")
    parser.add_argument("database", type=Path, help="destination SQLite file")
    parser.add_argument("--limit", type=positive_int, help="stop after this many entities for a partial test import")
    args = parser.parse_args()

    try:
        scanned, saved, partial = scan(args.dump, args.database, args.limit)
    except KeyboardInterrupt:
        print("Scan interrupted", file=sys.stderr)
        return 130
    except (OSError, EOFError, ValueError, sqlite3.Error, zlib.error) as error:
        print(f"Scan failed: {error}", file=sys.stderr)
        return 1
    label = "partial catalog" if partial else "catalog"
    print(f"Scanned {scanned:,} entities, saved {saved:,} candidates to {label} {args.database}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
