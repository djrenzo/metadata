// scrape.js
//
// Fetches TV series from the official TMDB API (/discover/tv) for a range
// of pages and writes one JSON file per series to
// OUTPUT_DIR/tv/tmdb/{tmdb_id}.json.
//
// No CLI args - configured via environment variables so this can be called
// directly from a GitHub Actions workflow:
//
//   TMDB_BEARER_TOKEN=xxx START_PAGE=1 END_PAGE=400 OUTPUT_DIR=. node scrape.js
//
// Env vars:
//   TMDB_BEARER_TOKEN   TMDB API Read Access Token (required)
//   TMDB_ID              optional single TMDB TV ID to fetch directly
//   START_PAGE          first page to fetch (default: 1)
//   END_PAGE            last page to fetch, inclusive (default: 1, TMDB caps at 500)
//   OUTPUT_DIR           root output dir; files land in OUTPUT_DIR/tv/tmdb/ (default: ".")
//   DELAY_MS             delay between page requests in ms (default: 250)
//
// Requires Node 18+ (for built-in fetch).

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const TMDB_API_BASE = "https://api.themoviedb.org/3";
const TMDB_IMAGE_BASE = "https://image.tmdb.org/t/p/w500";
const TMDB_MAX_PAGE = 500; // hard limit imposed by TMDB's API

const CINEMETA_API_BASE = (imdb_id) => `https://cinemeta-live.strem.io/meta/series/${imdb_id}.json`;

// ---- config from env ------------------------------------------------------

const TMDB_BEARER_TOKEN = process.env.TMDB_BEARER_TOKEN;
const TMDB_ID = process.env.TMDB_ID ? String(process.env.TMDB_ID).trim() : "";
const START_PAGE = parseInt(process.env.START_PAGE ?? "1", 10);
const END_PAGE = parseInt(process.env.END_PAGE ?? "1", 10);
const OUTPUT_DIR = process.env.OUTPUT_DIR ?? ".";
const DELAY_MS = parseInt(process.env.DELAY_MS ?? "500", 10);

const SERIES_DIR = path.join(OUTPUT_DIR, "tv", "tmdb");
const SERIES_DIR_IMDB = path.join(OUTPUT_DIR, "tv", "imdb");
const HEADERS = {
  Authorization: `Bearer ${TMDB_BEARER_TOKEN}`,
  Accept: "application/json",
};

// ---- helpers ----------------------------------------------------------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetches one page of /discover/tv, sorted by popularity.
 */
async function fetchDiscoverPage(page) {
  const url = new URL(`${TMDB_API_BASE}/discover/tv`);
  url.searchParams.set("page", String(page));
  url.searchParams.set("sort_by", "popularity.desc");
  url.searchParams.set("include_adult", "false");

  const response = await fetch(url, {
    headers: {
      ...HEADERS,
    },
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Page ${page} failed: HTTP ${response.status} ${body.slice(0, 200)}`);
  }

  return response.json();
}

/**
 * Fetches the full details for a TV series by TMDB ID.
 */
async function fetchID(tmdb_id) {
  const url = new URL(`${TMDB_API_BASE}/tv/${tmdb_id}`);

  const response = await fetch(url, {
    headers: {
      ...HEADERS,
    },
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`TV series ${tmdb_id} failed: HTTP ${response.status} ${body.slice(0, 200)}`);
  }

  return response.json();
}

/**
 * Fetches the full details for a TV series by IMDB ID.
 */
async function fetchIMDB(imdb_id) {
  const url = new URL(`${CINEMETA_API_BASE(imdb_id)}`);

  const response = await fetch(url);

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`TV series ${imdb_id} failed: HTTP ${response.status} ${body.slice(0, 200)}`);
  }

  return response.json();
}

/**
 * Fetches the external IDs for a TV series by TMDB ID.
 */
async function fetchExternalIDS(tmdb_id) {
  const url = new URL(`${TMDB_API_BASE}/tv/${tmdb_id}/external_ids`);

  const response = await fetch(url, {
    headers: {
      ...HEADERS,
    },
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`TV series ${tmdb_id} failed: HTTP ${response.status} ${body.slice(0, 200)}`);
  }

  return response.json();
}

/**
 * Maps a raw TMDB discover result to the shape we persist.
 */
function toSeriesRecord(result) {
  return {
    tmdb_id: String(result.id),
    title: result.name,
    url: `https://www.themoviedb.org/tv/${result.id}`,
    poster: result.poster_path || null,
    backdrop: result.backdrop_path || null,
    first_air_date: result.first_air_date || null,
    overview: result.overview || null,
    original_language: result.original_language || null,
    origin_country: result.origin_country || [],
    popularity: result.popularity ?? null,
    vote_average: result.vote_average ?? null,
    vote_count: result.vote_count ?? null,
  };
}

/**
 * Writes a single series to OUTPUT_DIR/tv/tmdb/{tmdb_id}.json
 */
async function writeSeriesFile(series) {
  const filePath = path.join(SERIES_DIR, `${series.tmdb_id}.json`);
  await writeFile(filePath, JSON.stringify(series, null, 2), "utf-8");
}

/**
 * Writes a single series to OUTPUT_DIR/tv/tmdb/{tmdb_id}.json
 */
async function writeSeriesFile2(tmdb_id, data) {
  const filePath = path.join(SERIES_DIR, `${tmdb_id}.json`);
  await writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
}

/**
 * Writes a single series to OUTPUT_DIR/tv/imdb/{imdb_id}.json
 */
async function writeIMDBFile(imdb_id, data) {
  const filePath = path.join(SERIES_DIR_IMDB, `${imdb_id}.json`);
  await writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
}

// ---- main ---------------------------------------------------------------

async function main() {
  if (!TMDB_BEARER_TOKEN) {
    throw new Error("TMDB_BEARER_TOKEN env var is required.");
  }

  await mkdir(SERIES_DIR, { recursive: true });
  await mkdir(SERIES_DIR_IMDB, { recursive: true });

  if (TMDB_ID) {
    console.log(`Fetching single TMDB ID ${TMDB_ID} into ${SERIES_DIR}/`);

    const data = await fetchID(TMDB_ID);
    const external_ids = await fetchExternalIDS(TMDB_ID);

    const imdb_id = external_ids.imdb_id ?? null;
    if (imdb_id) {
      try {
        const imdb_data = await fetchIMDB(imdb_id);
        const imdb_meta = imdb_data.meta ?? null;
        await writeIMDBFile(imdb_id, imdb_meta);
      } catch (err) {
        console.error(`  series ${TMDB_ID} IMDB fetch failed: ${err.message}`);
      }
    } else {
      console.warn(`  series ${TMDB_ID} has no IMDB ID`);
    }

    data.external_ids = external_ids;
    await writeSeriesFile2(TMDB_ID, data);

    console.log(`Done. Wrote 1 series file to ${SERIES_DIR}/`);
    return;
  }

  if (Number.isNaN(START_PAGE) || Number.isNaN(END_PAGE) || START_PAGE < 1 || END_PAGE < START_PAGE) {
    throw new Error(
      `Invalid page range: START_PAGE=${process.env.START_PAGE} END_PAGE=${process.env.END_PAGE}`
    );
  }

  const effectiveEndPage = Math.min(END_PAGE, TMDB_MAX_PAGE);
  if (effectiveEndPage < END_PAGE) {
    console.warn(`END_PAGE ${END_PAGE} exceeds TMDB's ${TMDB_MAX_PAGE}-page cap, clamping.`);
  }

  console.log(`Fetching pages ${START_PAGE}-${effectiveEndPage} into ${SERIES_DIR}/`);

  let totalWritten = 0;

  for (let page = START_PAGE; page <= effectiveEndPage; page++) {
    console.log(`Fetching page ${page}...`);

    let data;
    try {
      data = await fetchDiscoverPage(page);
    } catch (err) {
      console.error(`  page ${page} failed: ${err.message}`);
      continue; // keep going rather than aborting the whole run
    }

    const results = data.results ?? [];

    if (results.length === 0) {
      console.log(`Page ${page} returned no results, stopping.`);
      break;
    }

    for (const result of results) {
    //   const series = toSeriesRecord(result);
    //   await writeSeriesFile(series);

      const tmdb_id = String(result.id);
      const data = await fetchID(tmdb_id);
      const external_ids = await fetchExternalIDS(tmdb_id);

      const imdb_id = external_ids.imdb_id ?? null;
      if (imdb_id) {
        try {
          const imdb_data = await fetchIMDB(imdb_id);
          const imdb_meta = imdb_data.meta ?? null;
          await writeIMDBFile(imdb_id, imdb_meta);
        } catch (err) {
          console.error(`  series ${tmdb_id} IMDB fetch failed: ${err.message}`);
        }
      }
      else {
        console.warn(`  series ${tmdb_id} has no IMDB ID`);
      }
    
      data.external_ids = external_ids;

      await writeSeriesFile2(tmdb_id, data);
      totalWritten++;
    }

    console.log(
      `  -> wrote ${results.length} series (total: ${totalWritten}, TMDB reports total_pages=${data.total_pages})`
    );

    // Stop early if we've reached TMDB's own last page.
    if (data.total_pages && page >= data.total_pages) {
      console.log(`Reached TMDB's last page (${data.total_pages}), stopping.`);
      break;
    }

    if (page < effectiveEndPage) {
      await sleep(DELAY_MS);
    }
  }

  console.log(`Done. Wrote ${totalWritten} series files to ${SERIES_DIR}/`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
