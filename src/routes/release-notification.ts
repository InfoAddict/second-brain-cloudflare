import type { Env } from "../env";
import { json } from "../lib/http";

const RELEASE_EMAIL_FROM = "releases@updates.infoaddict.net";
const RELEASE_EMAIL_TO = "dan@infoaddict.net";
const RELEASE_DEPLOYMENT_URL = "https://brain.infoaddict.com";
const NOTIFICATION_STATUSES = ["applied", "blocked", "failed", "test"] as const;

type NotificationStatus = typeof NOTIFICATION_STATUSES[number];

interface ReleaseNotificationBody {
  releaseTag?: string;
  releaseName?: string;
  releaseUrl?: string;
  status?: NotificationStatus;
  details?: string;
  actionUrl?: string;
  test?: boolean;
}

function requireReleaseNotificationAuth(request: Request, env: Env): Response | null {
  if (request.headers.get("Authorization") === `Bearer ${env.RELEASE_NOTIFY_TOKEN}`) return null;
  return json({ ok: false, error: "Unauthorized" }, 401);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[char] ?? char);
}

function isGitHubUrl(value: string, releaseOnly = false): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && url.hostname === "github.com"
      && (!releaseOnly || url.pathname.includes("/releases/"));
  } catch {
    return false;
  }
}

function notificationCopy(status: NotificationStatus, releaseLabel: string, releaseTag: string) {
  switch (status) {
    case "blocked":
      return {
        subject: `Second Brain update needs attention: ${releaseTag}`,
        intro: `Second Brain detected ${releaseLabel}, but merge conflicts prevented an automatic update. Main and the live Worker were not changed.`,
        actionLabel: "Open the draft update PR",
      };
    case "failed":
      return {
        subject: `Second Brain update failed: ${releaseTag}`,
        intro: `Second Brain detected ${releaseLabel}, but its checks or deployment did not complete successfully. The live Worker was not reported as updated.`,
        actionLabel: "Open the failed workflow run",
      };
    case "test":
      return {
        subject: "Second Brain release email test",
        intro: `This is a setup test for automatic release notifications using ${releaseLabel}.`,
        actionLabel: "Open the workflow run",
      };
    default:
      return {
        subject: `Second Brain updated: ${releaseTag}`,
        intro: `Second Brain was updated to ${releaseLabel} after its checks passed and the Worker deployed successfully.`,
        actionLabel: "Open the workflow run",
      };
  }
}

export async function handleReleaseNotificationRoutes(
  request: Request,
  url: URL,
  env: Env,
  _ctx: ExecutionContext,
): Promise<Response | null> {
  if (url.pathname !== "/internal/release-notification" || request.method !== "POST") {
    return null;
  }

  const authErr = requireReleaseNotificationAuth(request, env);
  if (authErr) return authErr;

  let body: ReleaseNotificationBody;
  try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }

  const releaseTag = body.releaseTag?.trim();
  const releaseName = body.releaseName?.trim();
  const releaseUrl = body.releaseUrl?.trim();
  const details = body.details?.trim() || "";
  const actionUrl = body.actionUrl?.trim() || "";
  const status = body.status ?? (body.test === true ? "test" : "applied");

  if (!releaseTag || !releaseName || !releaseUrl) {
    return json({ ok: false, error: "releaseTag, releaseName, and releaseUrl are required" }, 400);
  }
  if (releaseTag.length > 100 || releaseName.length > 200 || releaseUrl.length > 500 || details.length > 1000 || actionUrl.length > 500) {
    return json({ ok: false, error: "Release notification metadata is too long" }, 400);
  }
  if (!(NOTIFICATION_STATUSES as readonly string[]).includes(status)) {
    return json({ ok: false, error: `status must be one of: ${NOTIFICATION_STATUSES.join(", ")}` }, 400);
  }
  if (!isGitHubUrl(releaseUrl, true)) {
    return json({ ok: false, error: "releaseUrl must be a GitHub release URL" }, 400);
  }
  if (actionUrl && !isGitHubUrl(actionUrl)) {
    return json({ ok: false, error: "actionUrl must be a GitHub URL" }, 400);
  }

  const releaseLabel = releaseName === releaseTag ? releaseTag : `${releaseName} (${releaseTag})`;
  const copy = notificationCopy(status, releaseLabel, releaseTag);
  const textSections = [copy.intro];
  if (details) textSections.push(`Details: ${details}`);
  if (actionUrl) textSections.push(`${copy.actionLabel}: ${actionUrl}`);
  textSections.push(`Live Worker: ${RELEASE_DEPLOYMENT_URL}`);
  textSections.push(`Release notes: ${releaseUrl}`);

  const htmlSections = [`<p>${escapeHtml(copy.intro)}</p>`];
  if (details) htmlSections.push(`<p><strong>Details:</strong><br>${escapeHtml(details).replace(/\n/g, "<br>")}</p>`);
  if (actionUrl) htmlSections.push(`<p><a href="${escapeHtml(actionUrl)}">${escapeHtml(copy.actionLabel)}</a></p>`);
  htmlSections.push(`<p><a href="${RELEASE_DEPLOYMENT_URL}">Open the live Worker</a></p>`);
  htmlSections.push(`<p><a href="${escapeHtml(releaseUrl)}">View the upstream release notes</a></p>`);

  try {
    const result = await env.RELEASE_EMAIL.send({
      from: RELEASE_EMAIL_FROM,
      to: RELEASE_EMAIL_TO,
      subject: copy.subject,
      text: textSections.join("\n\n"),
      html: htmlSections.join(""),
    });
    return json({ ok: true, messageId: result.messageId, test: status === "test", status });
  } catch (error) {
    console.error("Release notification email failed:", error);
    return json({ ok: false, error: "Release notification email failed" }, 502);
  }
}
