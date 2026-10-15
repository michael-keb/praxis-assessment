#!/usr/bin/env node
/**
 * Scrape https://www.wisdomcentre.com.au/ (Cloudflare-protected PBHS site).
 * Uses Playwright Chromium so the JS challenge can complete.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "..", "downloads", "wisdomcentre");
const BASE = "https://www.wisdomcentre.com.au";

const SEED_URLS = [
  `${BASE}/`,
  `${BASE}/patient-information/`,
  `${BASE}/patient-information/introduction/`,
  `${BASE}/patient-information/why-choose-our-practice/`,
  `${BASE}/patient-information/scheduling/`,
  `${BASE}/patient-information/first-visit/`,
  `${BASE}/patient-information/patient-registration/`,
  `${BASE}/patient-information/virtual-tour/`,
  `${BASE}/patient-information/privacy-policy/`,
  `${BASE}/procedures/`,
  `${BASE}/procedures/dental-implants/`,
  `${BASE}/procedures/dental-implants/replacing-missing-teeth/`,
  `${BASE}/procedures/dental-implants/overview-of-implant-placement/`,
  `${BASE}/procedures/dental-implants/missing-all-upper-or-lower-teeth/`,
  `${BASE}/procedures/dental-implants/bone-grafting-for-implants/`,
  `${BASE}/procedures/dental-implants/implant-supported-overdenture/`,
  `${BASE}/procedures/dental-implants/zygomatic-implants/`,
  `${BASE}/procedures/dental-implants/after-implant-placement/`,
  `${BASE}/procedures/dental-implants/cost-of-dental-implants/`,
  `${BASE}/procedures/bone-grafting/`,
  `${BASE}/procedures/bone-grafting/jaw-bone-health/`,
  `${BASE}/procedures/bone-grafting/jawbone-loss-and-deterioration/`,
  `${BASE}/procedures/bone-grafting/about-bone-grafting/`,
  `${BASE}/procedures/bone-grafting/ridge-augmentation/`,
  `${BASE}/procedures/bone-grafting/sinus-lift/`,
  `${BASE}/procedures/bone-grafting/nerve-repositioning/`,
  `${BASE}/procedures/bone-grafting/socket-preservation/`,
  `${BASE}/procedures/wisdom-teeth/`,
  `${BASE}/procedures/wisdom-teeth/impacted-wisdom-teeth/`,
  `${BASE}/procedures/wisdom-teeth/wisdom-teeth-removal/`,
  `${BASE}/procedures/wisdom-teeth/after-extraction-of-wisdom-teeth/`,
  `${BASE}/procedures/jaw-surgery/`,
  `${BASE}/procedures/facial-trauma/`,
  `${BASE}/procedures/tooth-extractions/`,
  `${BASE}/procedures/pre-prosthetic-surgery/`,
  `${BASE}/procedures/oral-pathology/`,
  `${BASE}/procedures/platelet-rich-fibrin/`,
  `${BASE}/procedures/impacted-canines/`,
  `${BASE}/procedures/3d-imaging/`,
  `${BASE}/procedures/anesthesia/`,
  `${BASE}/surgical-instructions/`,
  `${BASE}/surgical-instructions/before-anesthesia/`,
  `${BASE}/surgical-instructions/dental-implant-surgery/`,
  `${BASE}/surgical-instructions/wisdom-tooth-removal/`,
  `${BASE}/surgical-instructions/exposure-of-an-impacted-tooth/`,
  `${BASE}/surgical-instructions/extractions/`,
  `${BASE}/surgical-instructions/multiple-extractions/`,
  `${BASE}/referring-doctors/`,
  `${BASE}/referring-doctors/referral-form/`,
  `${BASE}/meet-us/`,
  `${BASE}/meet-us/meet-the-doctor/`,
  `${BASE}/meet-us/meet-the-staff/`,
  `${BASE}/contact-us/`,
  `${BASE}/contact-us/burwood-location/`,
  `${BASE}/disclaimer/`,
  `${BASE}/sitemap/`,
];

function slugFromUrl(url) {
  const u = new URL(url);
  let p = u.pathname.replace(/\/+$/, "") || "home";
  return p.replace(/^\//, "").replace(/\//g, "__") || "home";
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForChallenge(page) {
  for (let i = 0; i < 30; i++) {
    const title = await page.title();
    if (!/just a moment|attention required|sorry, you have been blocked/i.test(title)) {
      return true;
    }
    await sleep(1000);
  }
  return false;
}

async function extractPage(page) {
  return page.evaluate(() => {
    const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
    const main =
      document.querySelector("main") ||
      document.querySelector("#content") ||
      document.querySelector(".content") ||
      document.querySelector("article") ||
      document.body;

    const headings = [...main.querySelectorAll("h1, h2, h3")].map((el) => ({
      level: el.tagName.toLowerCase(),
      text: clean(el.textContent),
    }));

    const paragraphs = [...main.querySelectorAll("p")]
      .map((p) => clean(p.textContent))
      .filter((t) => t.length > 20);

    const lists = [...main.querySelectorAll("ul, ol")].map((list) =>
      [...list.querySelectorAll(":scope > li")]
        .map((li) => clean(li.textContent))
        .filter(Boolean)
    );

    const images = [...document.querySelectorAll("img[src]")]
      .map((img) => ({
        src: img.currentSrc || img.src,
        alt: clean(img.alt),
      }))
      .filter((i) => i.src && !/favicon|sprite|pixel|1x1/i.test(i.src));

    const links = [...main.querySelectorAll("a[href]")]
      .map((a) => ({ text: clean(a.textContent), href: a.href }))
      .filter((l) => l.href.startsWith("http"));

    // Prefer visible body text without nav chrome when possible
    const clone = main.cloneNode(true);
    for (const sel of ["nav", "header", "footer", "script", "style", "noscript", ".accessibility"]) {
      clone.querySelectorAll(sel).forEach((el) => el.remove());
    }
    const text = clean(clone.innerText || clone.textContent);

    return {
      title: clean(document.title),
      h1: clean(document.querySelector("h1")?.textContent || ""),
      metaDescription: clean(
        document.querySelector('meta[name="description"]')?.content || ""
      ),
      headings,
      paragraphs,
      lists,
      images,
      links,
      text,
    };
  });
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  fs.mkdirSync(path.join(OUT, "pages"), { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 900 },
  });
  const page = await context.newPage();

  const pages = [];
  const errors = [];

  console.log(`Scraping ${SEED_URLS.length} pages → ${OUT}`);

  for (let i = 0; i < SEED_URLS.length; i++) {
    const url = SEED_URLS[i];
    const slug = slugFromUrl(url);
    process.stdout.write(`[${i + 1}/${SEED_URLS.length}] ${url} ... `);
    try {
      const res = await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: 60000,
      });
      const ok = await waitForChallenge(page);
      if (!ok) {
        throw new Error(`Cloudflare challenge stuck (status ${res?.status()})`);
      }
      await sleep(400);
      const data = await extractPage(page);
      const record = {
        url,
        scrapedAt: new Date().toISOString(),
        status: res?.status() ?? null,
        ...data,
      };
      pages.push(record);
      fs.writeFileSync(
        path.join(OUT, "pages", `${slug}.json`),
        JSON.stringify(record, null, 2)
      );
      const md = [
        `# ${record.h1 || record.title}`,
        "",
        `URL: ${url}`,
        record.metaDescription ? `Description: ${record.metaDescription}` : "",
        "",
        record.text,
        "",
      ]
        .filter(Boolean)
        .join("\n");
      fs.writeFileSync(path.join(OUT, "pages", `${slug}.md`), md);
      console.log("ok");
    } catch (err) {
      console.log(`FAIL: ${err.message}`);
      errors.push({ url, error: String(err.message || err) });
    }
    await sleep(250);
  }

  const practice = {
    name: "Wisdom Specialist Centre",
    url: BASE,
    specialty: "Oral and Maxillofacial Surgery",
    location: {
      address: "Shop 1/8 Burwood Rd, Burwood NSW 2134",
      phone: "(02) 8021 2728",
      fax: "(02) 8021 2723",
      email: "info@wisdomcentre.com.au",
      areasServed: [
        "Croydon",
        "Ashfield",
        "Burwood",
        "Burwood Heights",
        "Strathfield",
      ],
    },
    doctor: {
      name: "Dr Khaled Zoud",
      credentials:
        "B.D.S (Hons) Syd., B.Med. (Hons) Newc., FRACDS(OMS), FICD",
      role: "Oral and Maxillofacial Surgeon; Senior Lecturer, University of Sydney",
    },
    mission:
      "Wisdom Specialist Centre strives to provide excellence in specialist treatment in a safe and caring environment.",
    scrapedAt: new Date().toISOString(),
    pageCount: pages.length,
    errorCount: errors.length,
  };

  const index = {
    practice,
    pages: pages.map((p) => ({
      url: p.url,
      title: p.title,
      h1: p.h1,
      metaDescription: p.metaDescription,
      textLength: (p.text || "").length,
    })),
    errors,
  };

  fs.writeFileSync(path.join(OUT, "index.json"), JSON.stringify(index, null, 2));
  fs.writeFileSync(
    path.join(OUT, "site.json"),
    JSON.stringify({ practice, pages, errors }, null, 2)
  );

  const summaryMd = [
    `# ${practice.name}`,
    "",
    `- **URL:** ${practice.url}`,
    `- **Specialty:** ${practice.specialty}`,
    `- **Address:** ${practice.location.address}`,
    `- **Phone:** ${practice.location.phone}`,
    `- **Email:** ${practice.location.email}`,
    `- **Doctor:** ${practice.doctor.name} — ${practice.doctor.credentials}`,
    `- **Pages scraped:** ${pages.length}`,
    `- **Errors:** ${errors.length}`,
    "",
    "## Sitemap / pages",
    "",
    ...pages.map((p) => `- [${p.h1 || p.title}](${p.url})`),
    errors.length
      ? ["", "## Errors", "", ...errors.map((e) => `- ${e.url}: ${e.error}`)].join(
          "\n"
        )
      : "",
    "",
  ].join("\n");

  fs.writeFileSync(path.join(OUT, "SUMMARY.md"), summaryMd);

  await browser.close();
  console.log(`\nDone. ${pages.length} pages, ${errors.length} errors → ${OUT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
