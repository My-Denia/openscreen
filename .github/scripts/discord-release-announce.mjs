import { info, warning } from "@actions/core";
import { context, getOctokit } from "@actions/github";

const botToken = (process.env.DISCORD_BOT_TOKEN || "").trim();
const channelId = (
	process.env.DISCORD_RC_TESTING_CHANNEL_ID ||
	process.env.DISCORD_RELEASE_CHANNEL_ID ||
	""
).trim();

const kind = (process.env.KIND || "stable").trim();
const stableTag = (process.env.STABLE_TAG || "").trim();
const rcTag = (process.env.RC_TAG || "").trim();
const extra = (process.env.EXTRA || "").trim();

if (!stableTag) {
	warning("STABLE_TAG missing; skipping.");
	process.exit(0);
}
if (!botToken || !channelId) {
	info("Discord announce skipped: set DISCORD_BOT_TOKEN and a channel id variable.");
	process.exit(0);
}

const owner = context.repo.owner;
const repo = context.repo.repo;
const releaseUrl = `${context.serverUrl}/${owner}/${repo}/releases/tag/${stableTag}`;
const stableVersion = stableTag.replace(/^v/, "").replace(/-.*$/, "");

let closedIssues = [];
if (process.env.GITHUB_TOKEN) {
	try {
		const octokit = getOctokit(process.env.GITHUB_TOKEN);
		const versionTitle = `v${stableVersion}`;
		const milestones = await octokit.paginate(octokit.rest.issues.listMilestones, {
			owner,
			repo,
			state: "closed",
			per_page: 100,
		});
		const m = milestones.find((x) => x.title === versionTitle);
		if (m) {
			const issues = await octokit.paginate(octokit.rest.issues.listForRepo, {
				owner,
				repo,
				milestone: `${m.number}`,
				state: "closed",
				per_page: 100,
			});
			closedIssues = issues
				.filter((i) => !i.pull_request)
				.slice(0, 20)
				.map((i) => `• [#${i.number}](${i.html_url}) ${i.title}`);
		}
	} catch (err) {
		warning(`Failed to fetch closed issues: ${err?.message ?? err}`);
	}
}

const isRc = kind === "rc";
const embedTitle = isRc
	? `🧪 ${stableTag} release candidate ready for testing`
	: `🚀 ${stableTag} released`;
const threadName = isRc ? `${stableTag} RC — testing` : `${stableTag} released`;
const color = isRc ? 15844367 : 5814783;

const description = [
	extra ? `> ${extra}\n` : "",
	`📦 **Download:** [${stableTag}](${releaseUrl})`,
	isRc && rcTag ? `_Promoted from \`${rcTag}\`_` : "",
	closedIssues.length > 0 ? `\n**Closed issues in this release:**\n${closedIssues.join("\n")}` : "",
]
	.filter(Boolean)
	.join("\n");

async function fetchChannelType() {
	const res = await fetch(`https://discord.com/api/v10/channels/${channelId}`, {
		headers: { Authorization: `Bot ${botToken}` },
	});
	if (!res.ok) {
		const txt = await res.text();
		warning(`Discord channel fetch failed ${res.status}: ${txt}`);
		return null;
	}
	return res.json();
}

async function postToForum() {
	// Forum channel (type 15): create a thread, the first message is the announcement.
	const body = {
		name: threadName.slice(0, 100),
		message: {
			embeds: [
				{
					title: embedTitle,
					url: releaseUrl,
					description,
					color,
					timestamp: new Date().toISOString(),
				},
			],
			allowed_mentions: { parse: [] },
		},
	};
	const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/threads`, {
		method: "POST",
		headers: { Authorization: `Bot ${botToken}`, "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	if (!res.ok) {
		const txt = await res.text();
		warning(`Discord forum thread create failed ${res.status}: ${txt}`);
		return false;
	}
	const data = await res.json();
	info(`📣 ${kind} announcement posted to forum thread ${data.id}.`);
	return true;
}

async function postToText() {
	const body = {
		embeds: [
			{
				title: embedTitle,
				url: releaseUrl,
				description,
				color,
				timestamp: new Date().toISOString(),
			},
		],
		allowed_mentions: { parse: [] },
	};
	const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
		method: "POST",
		headers: { Authorization: `Bot ${botToken}`, "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	if (!res.ok) {
		const txt = await res.text();
		warning(`Discord message POST failed ${res.status}: ${txt}`);
		return false;
	}
	info(`📣 ${kind} announcement posted to text channel.`);
	return true;
}

// Discord channel types that require a thread wrapper (no top-level messages).
const FORUM_LIKE_TYPES = new Set([15, 16]); // 15 = GUILD_FORUM, 16 = GUILD_MEDIA

const channel = await fetchChannelType();
if (!channel) {
	process.exit(0);
}

if (FORUM_LIKE_TYPES.has(channel.type)) {
	await postToForum();
} else {
	await postToText();
}
