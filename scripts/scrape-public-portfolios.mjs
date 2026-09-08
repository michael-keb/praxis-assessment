#!/usr/bin/env node
/**
 * Scrape publicly accessible portfolio pages (sites, Behance via curl) for missing designers.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT =
  process.env.INTERIOR_SRC ||
  "/Users/mk/Documents/Apps/Chrome Extensions/Chrome_assessment_miner/recruitment-manager/data/upwork-applicants/2095961518096053621";
const GALLERIES = path.join(ROOT, "portfolio-galleries.json");
const MANIFEST = path.join(ROOT, "portfolio-work-manifest.json");
const WORK = path.join(ROOT, "portfolio-work");

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

function slugify(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function fetchText(url) {
  return execFileSync("curl", ["-sL", "-A", UA, "--max-time", "45", url], {
    encoding: "utf8",
    maxBuffer: 25 * 1024 * 1024,
  });
}

function extractImages(html) {
  const found = new Set();
  const patterns = [
    /https:\/\/[^"'\s<>]+?\.(?:jpg|jpeg|png|webp)(?:\?[^"'\s<>]*)?/gi,
    /(?:https:)?\/\/[^"'\s<>]*squarespace-cdn\.com\/[^"'\s<>]+?\.(?:jpg|jpeg|png|webp)/gi,
    /project_modules\/[^"'\s<>]+?\.(?:jpg|jpeg|png|webp)/gi,
    /property="og:image"[^>]*content="([^"]+)"/gi,
    /content="([^"]+)"[^>]*property="og:image"/gi,
  ];
  for (const re of patterns) {
    for (const m of html.matchAll(re)) {
      let u = (m[1] || m[0]).replace(/&amp;/g, "&");
      if (u.startsWith("//")) u = `https:${u}`;
      if (u.startsWith("project_modules/"))
        u = `https://mir-s3-cdn-cf.behance.net/${u}`;
      if (!/\.(jpg|jpeg|png|webp)(\?|$)/i.test(u)) continue;
      if (/favicon|logo|emoji|avatar.*\.png/i.test(u)) continue;
      if (u.includes("/projects/404/")) continue;
      found.add(u);
    }
  }
  return [...found];
}

function isImage(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 5000) return false;
  const h = buf.subarray(0, 20).toString("utf8");
  if (h.startsWith("<!") || h.startsWith("<html")) return false;
  return (
    (buf[0] === 0xff && buf[1] === 0xd8) ||
    (buf[0] === 0x89 && buf[1] === 0x50) ||
    (buf.toString("ascii", 0, 4) === "RIFF")
  );
}

function ext(buf) {
  if (buf[0] === 0xff) return ".jpg";
  if (buf[0] === 0x89) return ".png";
  return ".webp";
}

function download(url, dest, referer) {
  const buf = execFileSync(
    "curl",
    ["-sL", "-A", UA, "-e", referer || url, "--max-time", "60", url],
    { maxBuffer: 25 * 1024 * 1024 },
  );
  if (!isImage(buf)) throw new Error("not image");
  const out = dest.replace(/\.(jpg|jpeg|png|webp)$/i, ext(buf));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, buf);
  return out;
}

function sourcesFor(app) {
  const urls = new Set();
  for (const u of app.cover_letter_links || []) urls.add(u);
  for (const w of app.web_discovered || []) {
    if (w.url && !/instagram|youtube|drive\.google/i.test(w.url)) urls.add(w.url);
  }
  return [...urls];
}

function existingCount(folderName) {
  const dir = path.join(WORK, folderName);
  if (!fs.existsSync(dir)) return 0;
  return fs.readdirSync(dir).filter((f) => /\.(jpg|jpeg|png|webp)$/i.test(f) && f !== "headshot.jpg").length;
}

const galleries = JSON.parse(fs.readFileSync(GALLERIES, "utf8"));
const workManifest = fs.existsSync(MANIFEST)
  ? JSON.parse(fs.readFileSync(MANIFEST, "utf8"))
  : { applicants: [] };
const byIndex = Object.fromEntries(workManifest.applicants.map((a) => [a.index, a]));

for (const app of galleries.applicants) {
  const folderName = `${String(app.index).padStart(2, "0")}__${slugify(app.name)}`;
  if (existingCount(folderName) >= 3) {
    console.log(`[${app.index}] ${app.name} — skip (${existingCount(folderName)} images)`);
    continue;
  }

  const urls = sourcesFor(app);
  if (!urls.length) {
    console.log(`[${app.index}] ${app.name} — no public URLs`);
    continue;
  }

  console.log(`\n[${app.index}] ${app.name} — ${urls.length} source(s)`);
  const outDir = path.join(WORK, folderName);
  fs.mkdirSync(outDir, { recursive: true });
  const downloaded = [];
  const seen = new Set();

  for (const srcUrl of urls) {
    try {
      const html = fetchText(srcUrl);
      const imgs = extractImages(html).slice(0, 16);
      console.log(`  ${srcUrl} → ${imgs.length} urls`);
      for (const imgUrl of imgs) {
        if (downloaded.length >= 12) break;
        const stem = imgUrl.split("/").pop()?.split(".")[0] ?? imgUrl;
        if (seen.has(stem)) continue;
        seen.add(stem);
        const dest = path.join(outDir, `${String(downloaded.length + 1).padStart(2, "0")}.jpg`);
        try {
          const saved = download(imgUrl, dest, srcUrl);
          const rel = path.relative(ROOT, saved).split(path.sep).join("/");
          downloaded.push({ file: rel, source_url: srcUrl, image_url: imgUrl });
          process.stdout.write(".");
        } catch {
          /* skip */
        }
      }
    } catch (e) {
      console.log(`  fail ${srcUrl}: ${e.message}`);
    }
  }
  console.log(` → ${downloaded.length} saved`);

  if (downloaded.length) {
    const prev = byIndex[app.index] || {};
    byIndex[app.index] = {
      ...prev,
      index: app.index,
      name: app.name,
      folder: folderName,
      images: downloaded,
      hasWork: true,
    };
  }
}

const applicants = galleries.applicants.map((app) => {
  const prev = byIndex[app.index];
  if (prev?.images?.length) return prev;
  const folderName = `${String(app.index).padStart(2, "0")}__${slugify(app.name)}`;
  const dir = path.join(WORK, folderName);
  if (!fs.existsSync(dir)) return prev || { index: app.index, name: app.name, images: [] };
  const files = fs
    .readdirSync(dir)
    .filter((f) => /\.(jpg|jpeg|png|webp)$/i.test(f) && f !== "headshot.jpg")
    .sort()
    .map((f) => ({
      file: `portfolio-work/${folderName}/${f}`,
      source_url: "disk",
    }));
  if (!files.length) return prev || { index: app.index, name: app.name, images: [] };
  return { ...(prev || {}), index: app.index, name: app.name, folder: folderName, images: files };
});

fs.writeFileSync(
  MANIFEST,
  JSON.stringify(
    {
      built_at: new Date().toISOString(),
      job_id: galleries.job_id,
      job_title: galleries.job_title,
      applicants,
    },
    null,
    2,
  ),
);
console.log("\nUpdated manifest:", MANIFEST);
