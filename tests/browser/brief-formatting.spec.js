import { test, expect } from "@playwright/test";

const sample = `# Business Analyst — 15-Minute Digital Product Cognitive Assessment

## Scenario

You are the Business Analyst for a **B2B SaaS recruitment platform**.

### Initial Product Idea

The proposed experience includes:

* showing availability on candidate profiles;
* supporting an **available from** date;
  * keep the existing \`available_from\` field.

## Your Task

1. Explain the *tradeoffs*.
2. Recommend a next step.
3. State your assumptions.`;

test.beforeEach(async ({ page }) => {
  const login = await page.request.post("/api/auth/login", {
    data: { email: "brief-test@example.test", password: "local-brief-test-only" },
  });
  expect(login.ok()).toBeTruthy();
});

async function createAssessment(page, title, brief = "") {
  const response = await page.request.post("/api/admin/assessments", {
    data: { title, brief, durationMinutes: 15, requireLinkedin: false },
  });
  expect(response.ok()).toBeTruthy();
  return (await response.json()).assessment;
}

async function editAssessment(page, assessment) {
  await page.goto("/admin");
  await page.getByText(assessment.title, { exact: true }).locator("..").getByRole("button", { name: "Edit", exact: true }).click();
  await expect(page.locator("#a-brief")).toBeVisible();
}

async function paste(page, text, html = "") {
  const input = page.locator("#a-brief");
  await input.click();
  await input.evaluate((element, { text, html }) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData("text/plain", text);
    if (html) clipboardData.setData("text/html", html);
    element.dispatchEvent(new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }));
  }, { text, html });
}

async function save(page, id) {
  const response = page.waitForResponse((r) => r.url().endsWith(`/api/admin/assessments/${id}`) && r.request().method() === "PUT");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  expect((await response).ok()).toBeTruthy();
  await expect(page.locator("#a-brief")).toHaveCount(0);
  return (await (await page.request.get(`/api/admin/assessments/${id}`)).json()).assessment;
}

async function openCandidate(page, assessment) {
  const issued = await page.request.post("/api/admin/codes", { data: { count: 1, assessmentId: assessment.id } });
  const { codes } = await issued.json();
  const code = codes[0];
  const beforeResponse = await page.request.get(`/api/assessment/session?case=${code}`);
  expect(beforeResponse.ok()).toBeTruthy();
  const before = await beforeResponse.json();
  expect(before.assessment).not.toHaveProperty("brief");
  expect(before.sessionToken).toMatch(/\S+/);
  const sessionToken = before.sessionToken;
  const start = await page.request.post("/api/assessment/start", {
    headers: { "X-Assessment-Session": sessionToken },
    data: { caseId: code, name: "Brief browser test", sessionToken },
  });
  expect(start.ok()).toBeTruthy();
  const started = await start.json();
  // Resume a local test session. No real screen/audio capture is needed to
  // verify the candidate document underneath the existing resume overlay.
  await page.evaluate(({ code, sessionToken, startedAt }) => {
    localStorage.setItem(`praxis_owner_${code}`, sessionToken);
    localStorage.setItem(`praxis_assess_${code}`, JSON.stringify({
      startedAt, lastSavedAt: Date.now(), pausedTotal: 0,
      pauseStartedAt: null, zones: {}, confidence: null, log: [], done: false,
      candidate: { name: "Brief browser test" }, sessionToken,
    }));
  }, { code, sessionToken, startedAt: started.startedAt });
  await page.goto(`/assess?case=${code}`);
  await expect(page.locator(".open-brief .brief-content")).toBeVisible();
  return page.locator(".open-brief .brief-content");
}

test("Markdown paste survives preview, save, reopen and candidate rendering", async ({ page }, testInfo) => {
  const assessment = await createAssessment(page, "Markdown round trip");
  await editAssessment(page, assessment);
  await paste(page, sample);
  const input = page.locator("#a-brief");
  await expect(input.locator("h1")).toContainText("Business Analyst");
  await expect(input.locator("h2")).toHaveCount(2);
  await expect(input.locator("h3")).toHaveText("Initial Product Idea");
  await expect(input.locator("strong")).toHaveCount(2);
  await expect(input.locator("ol > li")).toHaveCount(3);
  await expect(input.locator("ul ul li")).toHaveCount(1);
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  const preview = page.locator(".brief-editor-preview");
  await expect(preview.locator("code")).toHaveText("available_from");
  const previewHTML = await preview.innerHTML();
  await page.locator(".brief-editor").screenshot({ path: testInfo.outputPath("formatted-brief.png") });
  const saved = await save(page, assessment.id);
  expect(saved.brief).toContain("# Business Analyst");
  expect(saved.brief).toContain("**B2B SaaS recruitment platform**");
  await editAssessment(page, assessment);
  await expect(input.locator("h1")).toContainText("Business Analyst");
  await expect(input.locator("ol > li")).toHaveCount(3);
  const candidate = await openCandidate(page, assessment);
  expect(await candidate.innerHTML()).toBe(previewHTML);
  const headingStyle = await candidate.locator("h1").evaluate((el) => ({
    transform: getComputedStyle(el).textTransform, size: parseFloat(getComputedStyle(el).fontSize),
  }));
  expect(headingStyle.transform).toBe("none");
  expect(headingStyle.size).toBe(32);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await candidate.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBeTruthy();
});

test("formatted HTML paste preserves headings, styled bold, links and list numbering", async ({ page }) => {
  const assessment = await createAssessment(page, "Rich paste round trip");
  await editAssessment(page, assessment);
  await paste(page, "Rich document", `<html><body><!--StartFragment-->
    <h1>Rich document</h1><h2>Scenario</h2><h3>Details</h3>
    <p><span style="font-weight:700">Operations</span> and <i>Sales</i><br>Second line</p>
    <ul><li>First bullet</li><li>Second bullet<ul><li>Nested bullet</li></ul></li></ul>
    <ol start="3"><li>Third step</li><li>Fourth step</li></ol>
    <p>Keep <code>available_from</code> and <a href="https://example.com/reference">the reference</a>.</p>
    <!--EndFragment--></body></html>`);
  const input = page.locator("#a-brief");
  await expect(input.locator("h1")).toHaveText("Rich document");
  await expect(input.locator("strong")).toHaveText("Operations");
  await expect(input.locator("ol")).toHaveAttribute("start", "3");
  await save(page, assessment.id);
  await editAssessment(page, assessment);
  await expect(input.locator("h3")).toHaveText("Details");
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  const preview = page.locator(".brief-editor-preview");
  await expect(preview.locator("strong")).toHaveText("Operations");
  await expect(preview.locator("em")).toHaveText("Sales");
  await expect(preview.locator("br")).toHaveCount(1);
  await expect(preview.locator("ol")).toHaveAttribute("start", "3");
  await expect(preview.locator("ul ul li")).toHaveText("Nested bullet");
  await expect(preview.locator("a")).toHaveAttribute("href", "https://example.com/reference");
});

test("toolbar applies headings, bold and numbered lists with working undo and redo", async ({ page }) => {
  const assessment = await createAssessment(page, "Toolbar editing");
  await editAssessment(page, assessment);
  const input = page.locator("#a-brief");
  await input.fill("Section title");
  for (const level of [1, 2, 3]) {
    await page.getByLabel("Text style").selectOption(String(level));
    await expect(input.locator(`h${level}`)).toHaveText("Section title");
  }
  await page.getByLabel("Text style").selectOption("paragraph");
  await input.press("ControlOrMeta+a");
  await page.getByRole("button", { name: "Bold", exact: true }).click();
  await expect(input.locator("strong")).toHaveText("Section title");
  await page.getByRole("button", { name: "Numbered list", exact: true }).click();
  await expect(input.locator("ol li strong")).toHaveText("Section title");
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(input.locator("ol")).toHaveCount(0);
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  await expect(input.locator("ol")).toHaveCount(1);
  const saved = await save(page, assessment.id);
  expect(saved.brief).toMatch(/1\. \*\*Section title\*\*/);
});

test("plain text briefs keep paragraphs and single line breaks after editing", async ({ page }) => {
  const assessment = await createAssessment(page, "Plain text compatibility", "First line\nSecond line\n\nAnother paragraph.");
  await editAssessment(page, assessment);
  const input = page.locator("#a-brief");
  await expect(input.locator("br")).toHaveCount(1);
  await expect(input.locator("p")).toHaveCount(2);
  await input.click();
  await input.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    range.collapse(false);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  });
  await input.pressSequentially(" Updated.");
  await save(page, assessment.id);
  await editAssessment(page, assessment);
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  const preview = page.locator(".brief-editor-preview");
  await expect(preview.locator("br")).toHaveCount(1);
  await expect(preview.locator("p")).toHaveCount(2);
  await expect(preview).toContainText("Another paragraph. Updated.");
});

test("changing assessments and cancelling resets the editor and preview", async ({ page }) => {
  const first = await createAssessment(page, "First draft", "# First heading");
  const second = await createAssessment(page, "Second draft", "## Second heading");
  await editAssessment(page, first);
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  await page.getByText(second.title, { exact: true }).locator("..").getByRole("button", { name: "Edit", exact: true }).click();
  await expect(page.locator("#a-brief h2")).toHaveText("Second heading");
  await expect(page.locator("#a-brief")).not.toContainText("First heading");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "New assessment", exact: true }).click();
  await expect(page.locator("#a-brief")).toHaveText("");
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  await expect(page.locator(".brief-editor-preview")).toContainText("Create something from nothing");
});

test("candidate and preview never execute HTML or unsafe Markdown links", async ({ page }) => {
  const assessment = await createAssessment(page, "Safe brief rendering", `# Safe heading

<script>window.briefScriptRan = true</script>

<img src=x onerror="window.briefScriptRan = true">

[unsafe](javascript:alert(1))

![tracking](https://example.com/tracking.png)`);
  await editAssessment(page, assessment);
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  const preview = page.locator(".brief-editor-preview");
  await expect(preview.locator("script, img, iframe")).toHaveCount(0);
  expect(await page.evaluate(() => window.briefScriptRan)).toBeUndefined();
  const candidate = await openCandidate(page, assessment);
  await expect(candidate.locator("script, img, iframe")).toHaveCount(0);
  await expect(candidate.locator('a[href^="javascript:"]')).toHaveCount(0);
  expect(await page.evaluate(() => window.briefScriptRan)).toBeUndefined();
});
