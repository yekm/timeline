# Atlas of Time

Atlas of Time is an interactive timeline for comparing biographies, historical events, and eras from the formation of Earth to the present. The site runs entirely in the browser.

## Run locally

From the repository root, start a local HTTP server with Python 3.10 or later.

```sh
python3 -m http.server 8000 --bind 127.0.0.1 --directory site
```

Open the [local Atlas of Time](http://127.0.0.1:8000/). The browser loads `site/data` when a local catalogue is present. Otherwise it loads the bundled catalogue in `site/catalogue`.

- Use **Layers** to choose categories and **Overview** to show the three overview scales. Click the top scale to choose a period. Drag the selection or its handles on the two lower scales to adjust the range.
- On the main timeline, scroll to zoom, drag or hold `Shift` and scroll to move across time, and use the vertical scrollbar for more rows. **Reset view** returns to the starting range.
- The catalogue language initially follows the first supported browser preference, with English as the fallback. You can also select a language manually. If an entry has no article in the selected language, its English Wikipedia link is used when available.

## Build the full catalogue locally

Download the [latest Wikidata JSON dump](https://dumps.wikimedia.org/wikidatawiki/entities/latest-all.json.gz). To use the snapshot included in the bundled catalogue, follow the archived `wikidata-20240101-all.json.gz` link in the [Wikidata download documentation](https://www.wikidata.org/wiki/Wikidata:Database_download#JSON_dumps_(recommended)). The dump is large. Keep the compressed file wherever you have space and pass its path to the scanner.

The scanner and exporter use Python 3.10 or later and its standard library. Run these commands from the repository root, substituting your dump path.

```sh
python3 importer/scan.py /path/to/latest-all.json.gz build/wikidata.sqlite
python3 importer/export.py build/wikidata.sqlite site/data \
  --languages en ru de fr es pt it ja zh ar --page-budget-mb 4000
```

The scanner reads gzip directly and builds a SQLite database of catalogue fields and class relationships. Scanning the full dump can take several hours. Reuse `build/wikidata.sqlite` to export again with different languages or category rules without rescanning the dump.

The exporter writes all cutoffs through 100% to `site/data`. Reload the local site to use the full catalogue. `--languages` sets the language editions to include, with English always included. Changing the language set can change the eligible entries and the cutoff counts. `--page-budget-mb` sets the generated catalogue size limit. The command raises it for local use with multiple languages.

For a quick test on a smaller input, scan a partial database and export it to a separate directory.

```sh
python3 importer/scan.py /path/to/latest-all.json.gz build/sample.sqlite --limit 10000
python3 importer/export.py build/sample.sqlite build/sample-data --allow-partial
```

## How popularity is ranked

Each entry is scored by how many language editions of Wikipedia have an article linked to the same Wikidata item. The exporter ranks people and events separately and keeps articles with the same score together, so the percentages are approximate. The numbers next to the cutoffs are cumulative counts of unique entries in the catalogue before layer and date filters. [Wikidata sitelinks documentation](https://www.wikidata.org/wiki/Help:Sitelinks)

The bundled catalogue contains the top 0.1% and 0.5% for English, Russian, German, French, Spanish, Portuguese, Italian, Japanese, Chinese, and Arabic. On GitHub Pages, selecting 1%, 10%, or 100% shows a notice linking to the local build instructions above.

## Update the bundled catalogue and deploy

Rebuild the compact catalogue from the same SQLite database.

```sh
python3 importer/export.py build/wikidata.sqlite site/catalogue \
  --languages en ru de fr es pt it ja zh ar --max-tier 0.5
```

Commit the generated `site/catalogue` files when updating the bundled data. Git ignores local dumps, SQLite databases, and the full catalogue in `site/data`.

In the [GitHub repository](https://github.com/yekm/timeline), select **Settings → Pages → Source → GitHub Actions**. Run **Deploy to GitHub Pages** from `master` to publish `site/` to [yekm.github.io/timeline](https://yekm.github.io/timeline/).

## Data sources

- Biographies, events, labels, and article links come from Wikidata. The structured data is available under CC0. [Wikidata licensing](https://www.wikidata.org/wiki/Wikidata:Licensing)
- Geological boundaries follow the June 2026 International Chronostratigraphic Chart. Historical era boundaries in the timeline are approximate and can vary by region. [International Commission on Stratigraphy chart](https://stratigraphy.org/ICSchart/ChronostratChart2026-06.pdf)
