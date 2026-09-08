#!/usr/bin/env node
/**
 * Copy portfolio-work images and merge paths into static/interior-designers/index.html.
 * Preserves the cognitive-assessment page when it already exists.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(HERE);
const DEFAULT_SRC =
  "/Users/mk/Documents/Apps/Chrome Extensions/Chrome_assessment_miner/recruitment-manager/data/upwork-applicants/2095961518096053621";
const SRC = process.env.INTERIOR_DESIGNERS_SRC || DEFAULT_SRC;
const DEST = path.join(REPO, "static", "interior-designers");
const DEST_HTML = path.join(DEST, "index.html");

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    const from = path.join(src, name);
    const to = path.join(dest, name);
    const st = fs.statSync(from);
    if (st.isDirectory()) copyDir(from, to);
    else fs.copyFileSync(from, to);
  }
}

function parseDataFromHtml(html) {
  const m = html.match(/const DATA = (\{[\s\S]*?\});/);
  return m ? JSON.parse(m[1]) : null;
}

function dedupeDisplayImages(files, workDir) {
  const resolved = files.map((f) => resolveDisplayPath(f, workDir));
  const bh = resolved.filter((f) => /\/bh\d+\./i.test(f));
  if (bh.length) return bh.slice(0, 12);
  const seen = new Set();
  const out = [];
  for (const f of resolved) {
    const stem = f.split("/").pop()?.replace(/\.\w+$/, "") ?? f;
    if (seen.has(stem)) continue;
    seen.add(stem);
    out.push(f);
  }
  return out.slice(0, 12);
}

function resolveDisplayPath(relPath, workDir) {
  const webRel = relPath.replace(/\.(png|webp|jpe?g)$/i, ".web.jpg");
  const rel = relPath.replace(/^portfolio-work\//, "");
  const web = webRel.replace(/^portfolio-work\//, "");
  if (fs.existsSync(path.join(workDir, web))) {
    return webRel.startsWith("portfolio-work/")
      ? webRel
      : `portfolio-work/${web}`;
  }
  return relPath;
}

function optimizePortfolioImages(workDir) {
  try {
    execFileSync("sips", ["-h"], { stdio: "ignore" });
  } catch {
    return;
  }
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      if (fs.statSync(p).isDirectory()) {
        walk(p);
        continue;
      }
      if (!/\.(png|jpe?g|webp)$/i.test(name) || name === "headshot.jpg") continue;
      const web = p.replace(/\.(png|jpe?g|webp)$/i, ".web.jpg");
      const size = fs.statSync(p).size;
      if (fs.existsSync(web) && fs.statSync(web).mtimeMs >= fs.statSync(p).mtimeMs) continue;
      if (size < 500_000 && /\.web\.jpg$/i.test(web)) continue;
      if (size < 500_000 && /\.(jpe?g|webp)$/i.test(name)) continue;
      try {
        execFileSync("sips", [
          "-s",
          "format",
          "jpeg",
          "-s",
          "formatOptions",
          "82",
          "-Z",
          "1400",
          p,
          "--out",
          web,
        ]);
      } catch {
        /* skip */
      }
    }
  };
  walk(workDir);
}

function pruneLargeOriginals(workDir) {
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      if (fs.statSync(p).isDirectory()) {
        walk(p);
        continue;
      }
      if (!/\.(png|jpe?g|webp)$/i.test(name) || name === "headshot.jpg") continue;
      const web = p.replace(/\.(png|jpe?g|webp)$/i, ".web.jpg");
      if (!fs.existsSync(web)) continue;
      if (fs.statSync(p).size > 500_000) fs.unlinkSync(p);
    }
  };
  walk(workDir);
}

function linkLabel(url) {
  try {
    const h = new URL(url).hostname.replace(/^www\./, "");
    if (h.includes("behance")) return "Behance";
    return h;
  } catch {
    return "Portfolio";
  }
}

function mergePortfolioIntoData(existingData, workManifest, galleries, workDir) {
  if (!existingData?.applicants?.length || !workManifest?.applicants) {
    return existingData;
  }
  const byId = Object.fromEntries(
    workManifest.applicants.map((a) => [a.index, a]),
  );
  const galleryById = Object.fromEntries(
    (galleries?.applicants || []).map((a) => [a.index, a]),
  );
  const skipLink = (u) =>
    /upwork\.com|youtube\.com|youtu\.be|drive\.google\.com/i.test(u);

  return {
    ...existingData,
    applicants: existingData.applicants.map((a) => {
      const src = byId[a.id];
      const gal = galleryById[a.id];
      if (!src) return a;
      const images = dedupeDisplayImages(
        (src.images || []).map((i) => i.file).filter(Boolean),
        workDir,
      );
      const links = [
        ...new Set([
          ...(src.cover_letter_links || []),
          ...(src.web_links || []),
        ]),
      ]
        .filter((u) => u && !skipLink(u))
        .slice(0, 4)
        .map((url) => ({ url, label: linkLabel(url) }));
      const rate = src.bid
        ? String(src.bid).replace(/^USD\s*/i, "$").trim()
        : a.rate;
      return {
        ...a,
        headshot: src.headshot || a.headshot,
        rate,
        images,
        links,
        profileUrl: gal?.upwork || src.upwork || a.profileUrl || null,
        hasWork: images.length > 0,
      };
    }),
  };
}

function injectData(html, data) {
  return html.replace(
    /const DATA = \{[\s\S]*?\};/,
    `const DATA = ${JSON.stringify(data)};`,
  );
}

const selector = path.join(SRC, "portfolio-selector.html");
const work = path.join(SRC, "portfolio-work");
const workManifest = path.join(SRC, "portfolio-work-manifest.json");
const galleriesJson = path.join(SRC, "portfolio-galleries.json");

if (!fs.existsSync(work)) {
  console.error("Missing portfolio-work:", work);
  process.exit(1);
}
if (!fs.existsSync(workManifest)) {
  console.error("Missing portfolio-work-manifest.json:", workManifest);
  process.exit(1);
}

const manifest = JSON.parse(fs.readFileSync(workManifest, "utf8"));
const galleries = fs.existsSync(galleriesJson)
  ? JSON.parse(fs.readFileSync(galleriesJson, "utf8"))
  : null;
const prevHtml = fs.existsSync(DEST_HTML) ? fs.readFileSync(DEST_HTML, "utf8") : "";
const prevData = parseDataFromHtml(prevHtml);
const selectorHtml = fs.existsSync(selector)
  ? fs.readFileSync(selector, "utf8")
  : "";

fs.mkdirSync(DEST, { recursive: true });

// Refresh images only — wipe and recopy portfolio-work
const workDest = path.join(DEST, "portfolio-work");
fs.rmSync(workDest, { recursive: true, force: true });
copyDir(work, workDest);
optimizePortfolioImages(workDest);
pruneLargeOriginals(workDest);

let html = prevHtml || selectorHtml;
if (!html) {
  console.error("No index.html source found");
  process.exit(1);
}

const baseData = prevData || parseDataFromHtml(selectorHtml);
const merged = mergePortfolioIntoData(baseData, manifest, galleries, workDest);
html = injectData(html, merged);
fs.writeFileSync(DEST_HTML, html, "utf8");

const files = [];
function count(dir) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) count(p);
    else files.push(p);
  }
}
count(DEST);
const bytes = files.reduce((n, f) => n + fs.statSync(f).size, 0);
console.log(`Synced ${files.length} files (${(bytes / 1e6).toFixed(1)} MB) → ${DEST}`);
for (const a of merged.applicants) {
  console.log(`  ${a.name}: ${a.images.length} portfolio images`);
}
