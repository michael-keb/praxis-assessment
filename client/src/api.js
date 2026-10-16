async function upload(path, files, field = "files") {
  const fd = new FormData();
  for (const f of files) fd.append(field, f);
  const res = await fetch(path, { method: "POST", body: fd });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw Object.assign(new Error(data?.error || res.statusText), { status: res.status });
  return data;
}

async function request(path, options = {}) {
  const res = await fetch(path, {
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  let data = null;
  try { data = await res.json(); } catch {}
  if (!res.ok) throw Object.assign(new Error(data?.error || res.statusText), { status: res.status });
  return data;
}

export const api = {
  me: () => request("/api/auth/me"),
  login: (body) => request("/api/auth/login", { method: "POST", body }),
  logout: () => request("/api/auth/logout", { method: "POST" }),
  adminCodes: () => request("/api/admin/codes"),
  adminIssue: (count, assessmentId) =>
    request("/api/admin/codes", { method: "POST", body: { count, assessmentId } }),
  adminVoid: (code) => request(`/api/admin/codes/${code}/void`, { method: "POST" }),
  adminSession: (code) => request(`/api/admin/sessions/${code}`),
  adminAssessments: () => request("/api/admin/assessments"),
  adminCreateAssessment: (body) => request("/api/admin/assessments", { method: "POST", body }),
  adminUpdateAssessment: (id, body) => request(`/api/admin/assessments/${id}`, { method: "PUT", body }),
  adminDeleteAssessment: (id) => request(`/api/admin/assessments/${id}`, { method: "DELETE" }),
  adminUploadAttachments: (id, files) => upload(`/api/admin/assessments/${id}/attachments`, files),
  adminDeleteAttachment: (id) => request(`/api/admin/attachments/${id}`, { method: "DELETE" }),
  adminUploadJobDescription: (id, file) => upload(`/api/admin/assessments/${id}/job-description`, [file], "file"),
  adminDeleteJobDescription: (id) => request(`/api/admin/assessments/${id}/job-description`, { method: "DELETE" }),
  adminEmployers: () => request("/api/admin/employers"),
  adminCreateEmployer: (body) => request("/api/admin/employers", { method: "POST", body }),
  adminUpdateEmployer: (id, body) => request(`/api/admin/employers/${id}`, { method: "PUT", body }),
  adminDeleteEmployer: (id) => request(`/api/admin/employers/${id}`, { method: "DELETE" }),
  adminUploadEmployerLogo: (id, file) => upload(`/api/admin/employers/${id}/logo`, [file], "file"),
  adminDeleteEmployerLogo: (id) => request(`/api/admin/employers/${id}/logo`, { method: "DELETE" })
};
