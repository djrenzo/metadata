// scrape.js
//
// Loops over a range of TMDB "discover/tv" pages (the internal HTML-fragment
// endpoint used for infinite scroll) and writes one JSON file per series to
// OUTPUT_DIR/tv/tmdb/{tmdb_id}.json.
//
// No CLI args - everything is configured via environment variables so this
// can be called directly from a GitHub Actions workflow:
//
//   START_PAGE=1 END_PAGE=400 OUTPUT_DIR=. node scrape.js
//
// Env vars:
//   START_PAGE   first page to fetch (default: 1)
//   END_PAGE     last page to fetch, inclusive (default: 1)
//   OUTPUT_DIR   root output dir; files land in OUTPUT_DIR/tv/tmdb/ (default: ".")
//   DELAY_MS     delay between page requests in ms (default: 500)
//
// Requires Node 18+ (for built-in fetch) and the `cheerio` package.

import * as cheerio from "cheerio";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const DISCOVER_URL = "https://www.themoviedb.org/discover/tv/items";
const REFERRER_URL = "https://www.themoviedb.org/tv";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:153.0) Gecko/20100101 Firefox/153.0";

// ---- config from env ------------------------------------------------------

const START_PAGE = parseInt(process.env.START_PAGE ?? "1", 10);
const END_PAGE = parseInt(process.env.END_PAGE ?? "1", 10);
const OUTPUT_DIR = process.env.OUTPUT_DIR ?? ".";
const DELAY_MS = parseInt(process.env.DELAY_MS ?? "500", 10);
const DEBUG = process.env.DEBUG === "1";

const SERIES_DIR = path.join(OUTPUT_DIR, "tv", "tmdb");

// ---- helpers ----------------------------------------------------------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildDiscoverBody(page) {
  const params = new URLSearchParams({
    "air_date.gte": "",
    "air_date.lte": "",
    certification: "",
    certification_country: "US",
    debug: "",
    "first_air_date.gte": "",
    "first_air_date.lte": "",
    include_adult: "false",
    include_softcore: "false",
    "latest_ceremony.gte": "",
    "latest_ceremony.lte": "",
    page: String(page),
    "primary_release_date.gte": "",
    "primary_release_date.lte": "",
    region: "US|XX",
    "release_date.gte": "",
    "release_date.lte": "",
    show_me: "everything",
    sort_by: "popularity.desc",
    "vote_average.gte": "0",
    "vote_average.lte": "10",
    "vote_count.gte": "0",
    watch_region: "US",
    with_genres: "",
    with_keywords: "",
    with_networks: "",
    with_origin_country: "",
    with_original_language: "",
    with_watch_monetization_types: "flatrate|free|ads|rent|buy",
    with_watch_providers: "",
    with_release_type: "",
    "with_runtime.gte": "0",
    "with_runtime.lte": "400",
  });
  return params.toString();
}

/**
 * Fetches one page of the discover/tv HTML fragment endpoint.
 */
async function fetchDiscoverPage(cookieHeader, page) {
  const response = await fetch(DISCOVER_URL, {
    method: "POST",
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "text/html, */*; q=0.01",
      "Accept-Language": "en-US,en;q=0.9",
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "X-Requested-With": "XMLHttpRequest",
      Referer: REFERRER_URL,
      ...(cookieHeader ? { Cookie: cookieHeader } : {}),
    },
    body: buildDiscoverBody(page),
  });

  const bodyText = await response.text();

  console.log(
    `  status=${response.status} content-type="${response.headers.get("content-type")}" bytes=${bodyText.length}`
  );

  if (!response.ok) {
    throw new Error(`Page ${page} failed: HTTP ${response.status}`);
  }

  if (DEBUG) {
    await mkdir("debug", { recursive: true });
    await writeFile(`debug/page-${page}.html`, bodyText, "utf-8");
  }

  return bodyText;
}

/**
 * Does an initial GET to /tv to pick up session cookies, since the
 * discover endpoint is called with credentials: include in the browser.
 */
async function primeCookies() {
  const response = await fetch(REFERRER_URL, {
    headers: { "User-Agent": USER_AGENT },
  });

  const setCookie = response.headers.getSetCookie
    ? response.headers.getSetCookie()
    : response.headers.raw?.()["set-cookie"] ?? [];

  return setCookie.map((c) => c.split(";")[0]).join("; ");
}

/**
 * Parses one HTML fragment and extracts series data.
 */
function parseSeries(html) {
  const $ = cheerio.load(html);
  const results = [];

  $(".options[data-media-type='tv']").each((_, el) => {
    const tmdbId = $(el).attr("data-id");
    const card = $(el).closest("[data-object-id]");

    const link = card.find("a[href^='/tv/']").first();
    const href = link.attr("href");
    const title = card.find("h2").first().text().trim();
    const poster = card.find("img.poster").attr("src") || null;
    const releaseDate = card.find(".release_date").first().text().trim() || null;

    if (tmdbId && href) {
      results.push({
        tmdb_id: tmdbId,
        title,
        url: `https://www.themoviedb.org${href}`,
        poster,
        first_air_date: releaseDate,
      });
    }
  });

  return results;
}

/**
 * Writes a single series to OUTPUT_DIR/tv/tmdb/{tmdb_id}.json
 */
async function writeSeriesFile(series) {
  const filePath = path.join(SERIES_DIR, `${series.tmdb_id}.json`);
  await writeFile(filePath, JSON.stringify(series, null, 2), "utf-8");
}

// ---- main ---------------------------------------------------------------

async function main() {
  if (Number.isNaN(START_PAGE) || Number.isNaN(END_PAGE) || START_PAGE < 1 || END_PAGE < START_PAGE) {
    throw new Error(
      `Invalid page range: START_PAGE=${process.env.START_PAGE} END_PAGE=${process.env.END_PAGE}`
    );
  }

  console.log(`Scraping pages ${START_PAGE}-${END_PAGE} into ${SERIES_DIR}/`);

  await mkdir(SERIES_DIR, { recursive: true });

  const cookieHeader = await primeCookies();

  let totalWritten = 0;

  for (let page = START_PAGE; page <= END_PAGE; page++) {
    console.log(`Fetching page ${page}...`);

    let html;
    try {
      html = await fetchDiscoverPage(cookieHeader, page);
    } catch (err) {
      console.error(`  page ${page} failed: ${err.message}`);
      continue; // keep going rather than aborting the whole run
    }

    const seriesOnPage = parseSeries(html);

    if (seriesOnPage.length === 0) {
      console.log(`Page ${page} returned no results, stopping.`);
      break;
    }

    for (const series of seriesOnPage) {
      await writeSeriesFile(series);
      totalWritten++;
    }

    console.log(`  -> wrote ${seriesOnPage.length} series (total: ${totalWritten})`);

    if (page < END_PAGE) {
      await sleep(DELAY_MS);
    }
  }

  console.log(`Done. Wrote ${totalWritten} series files to ${SERIES_DIR}/`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});