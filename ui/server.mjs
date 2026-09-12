import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { exec, spawn } from "node:child_process";
import { WebSocketServer, WebSocket } from "ws";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "..");
const PUBLIC_DIR = path.join(__dirname, "public");

// Load .env if exists
let envConfig = {};
try {
	const envPath = path.join(ROOT_DIR, ".env");
	if (fs.existsSync(envPath)) {
		const content = fs.readFileSync(envPath, "utf-8");
		for (const line of content.split("\n")) {
			const trimmed = line.trim();
			if (trimmed && !trimmed.startsWith("#")) {
				const eq = trimmed.indexOf("=");
				if (eq !== -1) {
					const key = trimmed.slice(0, eq).trim();
					const val = trimmed.slice(eq + 1).trim();
					envConfig[key] = val;
					if (!process.env[key]) {
						process.env[key] = val;
					}
				}
			}
		}
	}
} catch (e) {
	console.error("Error reading .env:", e.message);
}

let DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || envConfig.DEEPSEEK_API_KEY || "";
let DEEPSEEK_BASE_URL = process.env.DEEPSEEK_BASE_URL || envConfig.DEEPSEEK_BASE_URL || "https://api.deepseek.com";
let CURRENT_MODEL = process.env.PRIME_DEFAULT_MODEL || envConfig.PRIME_DEFAULT_MODEL || "deepseek-chat";
let THINKING_ENABLED = process.env.PRIME_THINKING_LEVEL !== "off";
const PORT = Number(process.env.PORT || envConfig.PORT || 4173);

// OpenWA WhatsApp gateway config
let OPENWA_BASE_URL = (process.env.OPENWA_BASE_URL || envConfig.OPENWA_BASE_URL || "http://localhost:2785").replace(/\/$/, "");
let OPENWA_API_KEY = process.env.OPENWA_API_KEY || envConfig.OPENWA_API_KEY || "";
let OPENWA_SESSION = process.env.OPENWA_SESSION || envConfig.OPENWA_SESSION || "vintoria-sales";
// GMaps job store (async detach so long crawls never block the WS loop)
const gmapsJobs = new Map();
const GMAPS_TMP_ROOT = path.join(osTmpDir(), "vintoria-gmaps");
function osTmpDir() {
	try {
		return fs.realpathSync(process.env.TEMP || process.env.TMP || "C:\\Windows\\Temp");
	} catch {
		return process.env.TEMP || "C:\\Windows\\Temp";
	}
}

// MIME types dictionary
const MIME_TYPES = {
	".html": "text/html; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".js": "application/javascript; charset=utf-8",
	".mjs": "application/javascript; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".svg": "image/svg+xml",
	".ico": "image/x-icon",
	".woff2": "font/woff2",
	".ttf": "font/ttf",
};

// Tool definitions for DeepSeek
const TOOLS_DEFINITIONS = [
	{
		type: "function",
		function: {
			name: "bash",
			description: "Execute a command in the project shell (PowerShell/Bash) and get stdout and stderr output.",
			parameters: {
				type: "object",
				properties: {
					command: {
						type: "string",
						description: "The shell command to run.",
					},
				},
				required: ["command"],
			},
		},
	},
	{
		type: "function",
		function: {
			name: "read_file",
			description: "Read the full contents of a file from the repository.",
			parameters: {
				type: "object",
				properties: {
					path: {
						type: "string",
						description: "Relative or absolute file path to read.",
					},
				},
				required: ["path"],
			},
		},
	},
	{
		type: "function",
		function: {
			name: "write_file",
			description: "Create or overwrite a file with given content in the repository.",
			parameters: {
				type: "object",
				properties: {
					path: {
						type: "string",
						description: "Relative or absolute file path.",
					},
					content: {
						type: "string",
						description: "New content for the file.",
					},
				},
				required: ["path", "content"],
			},
		},
	},
	{
		type: "function",
		function: {
			name: "list_files",
			description: "List files and directories within a given directory path.",
			parameters: {
				type: "object",
				properties: {
					directory: {
						type: "string",
						description: "Relative directory path (default: current root).",
					},
				},
			},
		},
	},
	{
		type: "function",
		function: {
			name: "search_code",
			description: "Search for a pattern or string across files in the workspace.",
			parameters: {
				type: "object",
				properties: {
					query: {
						type: "string",
						description: "The text or regex to search for.",
					},
				},
				required: ["query"],
			},
		},
	},
	{
		type: "function",
		function: {
			name: "gmaps_scrape",
			description: "Start a Google Maps lead scrape (Docker, gosom/google-maps-scraper). Writes queries to a file and runs detached. Always start with depth 1-2 validation, then expand. Returns jobId + outputDir. Poll with gmaps_status, read with gmaps_results.",
			parameters: {
				type: "object",
				properties: {
					queries: { type: "array", items: { type: "string" }, description: "One query per line, e.g. ['dentists in Berlin, Germany']. Use 'business in City, Country' format." },
					depth: { type: "number", description: "Scroll depth 1-10. Default 2. Keep 1-2 for validation." },
					format: { type: "string", description: "'csv' (default) or 'json' (JSON Lines, required for extra reviews/emails detail)." },
					email: { type: "boolean", description: "Visit websites to extract emails. Slower. Default false." },
					lang: { type: "string", description: "Language code, e.g. 'en', 'de', 'hi'. Default 'en'." },
				},
				required: ["queries"],
			},
		},
	},
	{
		type: "function",
		function: {
			name: "gmaps_status",
			description: "Poll a running/finished gmaps_scrape job. Returns container state, elapsed, result count.",
			parameters: { type: "object", properties: { jobId: { type: "string" } }, required: ["jobId"] },
		},
	},
	{
		type: "function",
		function: {
			name: "gmaps_results",
			description: "Read parsed leads from a gmaps job. Can filter to businesses with NO website (filter_no_website=true) and cap preview rows. Returns counts + preview + full file path.",
			parameters: {
				type: "object",
				properties: {
					jobId: { type: "string" },
					filter_no_website: { type: "boolean", description: "Only return businesses where website is empty." },
					limit: { type: "number", description: "Max preview rows. Default 20." },
				},
				required: ["jobId"],
			},
		},
	},
	{
		type: "function",
		function: {
			name: "openwa_status",
			description: "Check OpenWA gateway: sessions list, which session is READY, QR needed or not. Call before any send.",
			parameters: { type: "object", properties: { session: { type: "string", description: "Session name. Default vintoria-sales." } } },
		},
	},
	{
		type: "function",
		function: {
			name: "openwa_check",
			description: "Validate phone numbers exist on WhatsApp via GET /contacts/check. Always check before first message to new numbers.",
			parameters: {
				type: "object",
				properties: {
					numbers: { type: "array", items: { type: "string" }, description: "Phone numbers in international format, e.g. ['491701234567']" },
					session: { type: "string" },
				},
				required: ["numbers"],
			},
		},
	},
	{
		type: "function",
		function: {
			name: "openwa_send",
			description: "Send ONE WhatsApp text via POST /messages/send-text. Phone auto-normalized to chatId (digits@c.us). Keep under 4096 chars. Use {{name}} style personalization by filling text per recipient yourself.",
			parameters: {
				type: "object",
				properties: {
					to: { type: "string", description: "Phone digits or chatId, e.g. '491701234567' or '491701234567@c.us'" },
					text: { type: "string" },
					session: { type: "string" },
				},
				required: ["to", "text"],
			},
		},
	},
	{
		type: "function",
		function: {
			name: "openwa_qr",
			description: "Get WhatsApp pairing QR status for a session. Returns status (READY already-linked | qr_ready scan-needed + scan URL + expiry note). NEVER dump base64 into chat. Tell user to open the QR page in a browser and scan with their dedicated WhatsApp number.",
			parameters: { type: "object", properties: { session: { type: "string" } } },
		},
	},
	{
		type: "function",
		function: {
			name: "openwa_bulk",
			description: "Send bulk WhatsApp texts via POST /messages/send-bulk (max 100). Supports {{variables}} per message. Throttled with delayBetweenMessages. Confirm recipient list with user before large blasts.",
			parameters: {
				type: "object",
				properties: {
					messages: { type: "array", items: { type: "object" }, description: "[{to:'4917...', text:'Hi {{name}}...', variables:{name:'Asha'}}]" },
					session: { type: "string" },
					delayMs: { type: "number", description: "Delay between messages ms. Default 3000." },
				},
				required: ["messages"],
			},
		},
	},
];

// ---- OpenWA + GMaps helpers ----
function normalizeChatId(to) {
	let v = String(to || "").trim().replace(/^\+/, "").replace(/[\s\-()]/g, "");
	if (v.endsWith("@c.us") || v.endsWith("@g.us") || v.endsWith("@lid")) return v;
	if (!/^\d+$/.test(v)) return v;
	return `${v}@c.us`;
}
async function openwaFetch(apiPath, opts = {}) {
	if (!OPENWA_API_KEY) throw new Error("OPENWA_API_KEY not configured. Set it in .env and restart OpenWA + UI.");
	const res = await fetch(`${OPENWA_BASE_URL}/api${apiPath}`, {
		...opts,
		headers: { "Content-Type": "application/json", "X-API-Key": OPENWA_API_KEY, ...(opts.headers || {}) },
	});
	const text = await res.text();
	let body;
	try { body = JSON.parse(text); } catch { body = { raw: text }; }
	if (!res.ok) throw new Error(`OpenWA ${res.status}: ${text.slice(0, 500)}`);
	return body;
}
function parseCsvLine(line) {
	const out = [];
	let cur = "", inQ = false;
	for (let i = 0; i < line.length; i++) {
		const c = line[i];
		if (c === '"') { if (inQ && line[i + 1] === '"') { cur += '"'; i++; } else inQ = !inQ; }
		else if (c === "," && !inQ) { out.push(cur); cur = ""; }
		else cur += c;
	}
	out.push(cur);
	return out;
}
function readLeadsFile(job) {
	const csvPath = path.join(job.outputDir, "results.csv");
	const jsonPath = path.join(job.outputDir, "results.json");
	if (job.format === "json" && fs.existsSync(jsonPath)) {
		const lines = fs.readFileSync(jsonPath, "utf-8").split("\n").filter(Boolean);
		return lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
			.map((e) => ({ name: e.title || "", category: e.category || "", phone: e.phone || "", website: e.web_site || e.website || "", address: e.address || "", rating: e.review_rating ?? "", reviews: e.review_count ?? "", emails: e.emails || "" }));
	}
	if (fs.existsSync(csvPath)) {
		const raw = fs.readFileSync(csvPath, "utf-8").split("\n").filter((l) => l.trim());
		if (raw.length < 2) return [];
		const head = parseCsvLine(raw[0]);
		const idx = (n) => head.findIndex((h) => h.trim().toLowerCase() === n);
		const ti = idx("title"), ca = idx("category"), ph = idx("phone"), we = idx("website"), ad = idx("address"), ra = idx("review_rating"), rc = idx("review_count"), em = idx("emails");
		return raw.slice(1).map((l) => { const c = parseCsvLine(l); return { name: c[ti] || "", category: c[ca] || "", phone: c[ph] || "", website: c[we] || "", address: c[ad] || "", rating: c[ra] || "", reviews: c[rc] || "", emails: c[em] || "" }; });
	}
	return [];
}

// Tool execution logic
async function executeTool(name, args) {
	const startTime = Date.now();
	try {
		if (name === "bash") {
			const cmd = args.command;
			return new Promise((resolve) => {
				exec(cmd, { cwd: ROOT_DIR, maxBuffer: 1024 * 1024 * 5, timeout: 60000 }, (err, stdout, stderr) => {
					const duration = Date.now() - startTime;
					if (err) {
						resolve({
							success: false,
							output: (stdout ? stdout + "\n" : "") + (stderr || err.message),
							exitCode: err.code || 1,
							duration,
						});
					} else {
						resolve({
							success: true,
							output: stdout || (stderr ? "Stderr: " + stderr : "Command completed with no output."),
							exitCode: 0,
							duration,
						});
					}
				});
			});
		} else if (name === "read_file") {
			const targetPath = path.isAbsolute(args.path) ? args.path : path.join(ROOT_DIR, args.path);
			if (!fs.existsSync(targetPath)) {
				return { success: false, output: `File not found: ${args.path}`, duration: Date.now() - startTime };
			}
			const content = fs.readFileSync(targetPath, "utf-8");
			return {
				success: true,
				output: content.length > 50000 ? content.slice(0, 50000) + "\n...[truncated]" : content,
				duration: Date.now() - startTime,
			};
		} else if (name === "write_file") {
			const targetPath = path.isAbsolute(args.path) ? args.path : path.join(ROOT_DIR, args.path);
			fs.mkdirSync(path.dirname(targetPath), { recursive: true });
			fs.writeFileSync(targetPath, args.content, "utf-8");
			return { success: true, output: `Successfully wrote ${args.content.length} bytes to ${args.path}`, duration: Date.now() - startTime };
		} else if (name === "list_files") {
			const dir = args.directory ? (path.isAbsolute(args.directory) ? args.directory : path.join(ROOT_DIR, args.directory)) : ROOT_DIR;
			if (!fs.existsSync(dir)) {
				return { success: false, output: `Directory not found: ${args.directory}`, duration: Date.now() - startTime };
			}
			const entries = fs.readdirSync(dir, { withFileTypes: true });
			const list = entries
				.filter((e) => !e.name.startsWith(".git") && e.name !== "node_modules")
				.slice(0, 80)
				.map((e) => (e.isDirectory() ? `[DIR]  ${e.name}/` : `[FILE] ${e.name}`))
				.join("\n");
			return { success: true, output: list || "Empty directory.", duration: Date.now() - startTime };
		} else if (name === "search_code") {
			const query = args.query.toLowerCase();
			const matches = [];
			function walk(dir) {
				if (matches.length >= 25) return;
				const entries = fs.readdirSync(dir, { withFileTypes: true });
				for (const ent of entries) {
					if (ent.name.startsWith(".git") || ent.name === "node_modules" || ent.name === "dist") continue;
					const fullPath = path.join(dir, ent.name);
					if (ent.isDirectory()) {
						walk(fullPath);
					} else if (ent.isFile()) {
						try {
							const text = fs.readFileSync(fullPath, "utf-8");
							if (text.toLowerCase().includes(query)) {
								const rel = path.relative(ROOT_DIR, fullPath);
								const lines = text.split("\n");
								for (let i = 0; i < lines.length; i++) {
									if (lines[i].toLowerCase().includes(query)) {
										matches.push(`${rel}:${i + 1}: ${lines[i].trim()}`);
										if (matches.length >= 25) break;
									}
								}
							}
						} catch {
							// skip binary
						}
					}
				}
			}
			walk(ROOT_DIR);
			return { success: true, output: matches.length > 0 ? matches.join("\n") : `No matches found for "${args.query}".`, duration: Date.now() - startTime };
		} else if (name === "gmaps_scrape") {
			const queries = Array.isArray(args.queries) ? args.queries.filter(Boolean) : [];
			if (!queries.length) return { success: false, output: "gmaps_scrape: provide queries[] like ['dentists in Berlin, Germany']", duration: Date.now() - startTime };
			const depth = Math.min(Math.max(Number(args.depth || 2), 1), 10);
			const format = args.format === "json" ? "json" : "csv";
			const email = !!args.email;
			const lang = args.lang || "en";
			const jobId = "gmaps_" + Math.random().toString(36).slice(2, 9);
			const outputDir = path.join(GMAPS_TMP_ROOT, jobId);
			fs.mkdirSync(outputDir, { recursive: true });
			fs.writeFileSync(path.join(outputDir, "queries.txt"), queries.join("\n"), "utf-8");
			const outFile = format === "json" ? "/out/results.json" : "/out/results.csv";
			const container = `${jobId}`;
			const dockerArgs = ["run", "-d", "--rm", "--name", container, "-v", "gmaps-playwright-cache:/opt", "-v", `${path.join(outputDir, "queries.txt")}:/queries.txt:ro`, "-v", `${outputDir}:/out`, "gosom/google-maps-scraper", "-input", "/queries.txt", "-results", outFile, "-depth", String(depth), "-lang", lang, "-exit-on-inactivity", "3m"];
			if (email) dockerArgs.push("-email");
			if (format === "json") dockerArgs.push("-json");
			return new Promise((resolve) => {
				exec(`docker ${dockerArgs.map((a) => (a.includes(" ") || a.includes(":") ? `"${a}"` : a)).join(" ")}`, { cwd: ROOT_DIR, timeout: 60000 }, (err, stdout, stderr) => {
					if (err) {
						resolve({ success: false, output: `Docker start failed. Is Docker running? ${stderr || err.message}\nTried: docker ${dockerArgs.join(" ")}`, duration: Date.now() - startTime });
						return;
					}
					gmapsJobs.set(jobId, { jobId, container, outputDir, format, queries, depth, startedAt: Date.now(), containerId: stdout.trim() });
					resolve({ success: true, output: `Scrape started. jobId=${jobId}\nQueries: ${queries.length} | depth=${depth} | format=${format} | email=${email}\nOutput: ${outputDir}\nPoll with gmaps_status {jobId}, read with gmaps_results {jobId, filter_no_website}. First poll after ~30s.`, duration: Date.now() - startTime });
				});
			});
		} else if (name === "gmaps_status") {
			const job = gmapsJobs.get(args.jobId);
			if (!job) return { success: false, output: `Unknown jobId ${args.jobId}. Start with gmaps_scrape first.`, duration: Date.now() - startTime };
			const leads = readLeadsFile(job);
			return new Promise((resolve) => {
				exec(`docker inspect -f "{{.State.Status}}|{{.State.ExitCode}}" ${job.container}`, { timeout: 15000 }, (err, stdout) => {
					const state = err ? "exited-or-removed (likely finished)" : stdout.trim();
					resolve({ success: true, output: `jobId=${job.jobId}\ncontainer=${state}\nelapsed=${Math.round((Date.now() - job.startedAt) / 1000)}s\nresults_so_far=${leads.length}\noutputDir=${job.outputDir}\n${state.startsWith("exited") || err ? "Finished (or container removed). Use gmaps_results to read." : "Still running. Poll again in 30-60s; do NOT restart."}`, duration: Date.now() - startTime });
				});
			});
		} else if (name === "gmaps_results") {
			const job = gmapsJobs.get(args.jobId);
			if (!job) return { success: false, output: `Unknown jobId ${args.jobId}.`, duration: Date.now() - startTime };
			let leads = readLeadsFile(job);
			const total = leads.length;
			if (args.filter_no_website) leads = leads.filter((l) => !String(l.website || "").trim());
			const limit = Math.min(Number(args.limit || 20), 50);
			const preview = leads.slice(0, limit);
			const withPhone = leads.filter((l) => String(l.phone || "").trim()).length;
			return { success: true, output: `jobId=${job.jobId} | total=${total} | after_filter=${leads.length} | with_phone=${withPhone} | file=${path.join(job.outputDir, job.format === "json" ? "results.json" : "results.csv")}\n` + (preview.length ? preview.map((l, i) => `${i + 1}. ${l.name} | ${l.category} | ${l.phone || "no-phone"} | ${l.website || "NO-WEBSITE"} | ${l.address}`).join("\n") : "(no rows yet - crawl still running or zero results)") + (leads.length > limit ? `\n... +${leads.length - limit} more. Raise limit (max 50) or filter further.` : ""), duration: Date.now() - startTime };
		} else if (name === "openwa_status") {
			try {
				const session = args.session || OPENWA_SESSION;
				const data = await openwaFetch("/sessions");
				const sessions = data.sessions || data.data || data || [];
				return { success: true, output: `OpenWA ${OPENWA_BASE_URL}\ndefault_session=${session}\n${JSON.stringify(sessions, null, 2).slice(0, 4000)}\nIf session not READY: ask user to scan QR from OpenWA dashboard http://localhost:2785, then re-check.`, duration: Date.now() - startTime };
			} catch (e) {
				return { success: false, output: `OpenWA unreachable: ${e.message}\nStart it: cd OpenWA && docker compose -f docker-compose.dev.yml up -d (dashboard http://localhost:2785). Set OPENWA_API_KEY in ui/.env.`, duration: Date.now() - startTime };
			}
		} else if (name === "openwa_check") {
			try {
				const session = args.session || OPENWA_SESSION;
				const nums = (args.numbers || []).map((n) => String(n).replace(/\D/g, "")).filter(Boolean);
				if (!nums.length) return { success: false, output: "openwa_check: provide numbers[]", duration: Date.now() - startTime };
				const out = [];
				for (const n of nums.slice(0, 20)) {
					try { const r = await openwaFetch(`/sessions/${session}/contacts/check/${n}`); out.push(`${n}: ${r.exists ? "EXISTS " + (r.whatsappId || "") : "NOT-ON-WHATSAPP"}`); }
					catch (e) { out.push(`${n}: CHECK-FAILED ${e.message.slice(0, 120)}`); }
				}
				return { success: true, output: out.join("\n"), duration: Date.now() - startTime };
			} catch (e) {
				return { success: false, output: `openwa_check failed: ${e.message}`, duration: Date.now() - startTime };
			}
		} else if (name === "openwa_send") {
			try {
				const session = args.session || OPENWA_SESSION;
				if (!args.to || !args.text) return { success: false, output: "openwa_send needs {to, text}", duration: Date.now() - startTime };
				const r = await openwaFetch(`/sessions/${session}/messages/send-text`, { method: "POST", body: JSON.stringify({ chatId: normalizeChatId(args.to), text: args.text }) });
				return { success: true, output: `Sent to ${args.to} via ${session}. messageId=${r.messageId || JSON.stringify(r).slice(0, 200)}`, duration: Date.now() - startTime };
			} catch (e) {
				return { success: false, output: `openwa_send failed: ${e.message}`, duration: Date.now() - startTime };
			}
		} else if (name === "openwa_qr") {
			try {
				const session = args.session || OPENWA_SESSION;
				const list = await openwaFetch("/sessions");
				const sessions = list.sessions || list.data || list || [];
				const arr = Array.isArray(sessions) ? sessions : [];
				const hit = arr.find((s) => (s.name || s.id) === session || s.id === session);
				if (!hit) return { success: false, output: `No OpenWA session '${session}'. Create it from the OpenWA dashboard first.`, duration: Date.now() - startTime };
				const status = hit.status || "unknown";
				if (status === "ready" || status === "READY" || status === "connected") {
					return { success: true, output: `Session '${session}' is READY (already linked). No QR needed. Proceed to openwa_check/openwa_send.`, duration: Date.now() - startTime };
				}
				const sid = hit.id || hit.sessionId || session;
				let qrOk = false;
				try { const q = await openwaFetch(`/sessions/${sid}/qr`); qrOk = !!(q.qrCode || q.qr); } catch { qrOk = false; }
				const page = `/api/openwa/qr-page?session=${encodeURIComponent(session)}`;
				return { success: true, output: `Session '${session}' status=${status}. QR ${qrOk ? "AVAILABLE" : "not yet available — wait 15s and retry"}. Tell user: open ${page} in a browser (same host as this UI) and scan with the DEDICATED WhatsApp number within ~60s (QR rotates). Then ask them to say "check status" so you can re-verify with openwa_status. NEVER paste base64.`, duration: Date.now() - startTime };
			} catch (e) {
				return { success: false, output: `openwa_qr failed: ${e.message}`, duration: Date.now() - startTime };
			}
		} else if (name === "openwa_bulk") {
			try {
				const session = args.session || OPENWA_SESSION;
				const msgs = args.messages || [];
				if (!msgs.length) return { success: false, output: "openwa_bulk needs messages[]", duration: Date.now() - startTime };
				if (msgs.length > 100) return { success: false, output: "Max 100 per bulk call. Split batches.", duration: Date.now() - startTime };
				const payload = { messages: msgs.map((m) => ({ chatId: normalizeChatId(m.to), type: "text", content: { text: m.text }, variables: m.variables || {} })), options: { delayBetweenMessages: Number(args.delayMs || 3000), randomizeDelay: true, stopOnError: false } };
				const r = await openwaFetch(`/sessions/${session}/messages/send-bulk`, { method: "POST", body: JSON.stringify(payload) });
				return { success: true, output: `Bulk queued: batchId=${r.batchId || "?"} total=${msgs.length} status=${r.status || JSON.stringify(r).slice(0, 300)}`, duration: Date.now() - startTime };
			} catch (e) {
				return { success: false, output: `openwa_bulk failed: ${e.message}`, duration: Date.now() - startTime };
			}
		}
		return { success: false, output: `Unknown tool: ${name}`, duration: Date.now() - startTime };
	} catch (err) {
		return { success: false, output: `Tool error: ${err.message}`, duration: Date.now() - startTime };
	}
}

// In-memory sessions store
const activeSessions = new Map();

// HTTP server
const server = http.createServer((req, res) => {
	// Enable CORS
	res.setHeader("Access-Control-Allow-Origin", "*");
	res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
	res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

	if (req.method === "OPTIONS") {
		res.writeHead(204);
		res.end();
		return;
	}

	const parsedUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
	const pathname = parsedUrl.pathname;

	// API routes
	if (pathname === "/api/status" && req.method === "GET") {
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(
			JSON.stringify({
				status: "online",
				provider: "deepseek",
				currentModel: CURRENT_MODEL,
				hasKey: !!DEEPSEEK_API_KEY && DEEPSEEK_API_KEY.startsWith("sk-"),
				keyMasked: DEEPSEEK_API_KEY ? DEEPSEEK_API_KEY.slice(0, 7) + "..." + DEEPSEEK_API_KEY.slice(-4) : "",
				baseUrl: DEEPSEEK_BASE_URL,
				models: [
					{ id: "deepseek-chat", name: "DeepSeek Chat (V3)", context: "128K", reasoning: false, tag: "Fast & Precise" },
					{ id: "deepseek-reasoner", name: "DeepSeek Reasoner (R1)", context: "128K", reasoning: true, tag: "Chain of Thought" },
					{ id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", context: "1M", reasoning: true, tag: "Ultra Context" },
					{ id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", context: "1M", reasoning: true, tag: "High Speed" },
				],
				openwa: { baseUrl: OPENWA_BASE_URL, session: OPENWA_SESSION, hasKey: !!OPENWA_API_KEY },
				gmapsJobs: [...gmapsJobs.keys()],
				rootPath: ROOT_DIR,
			}),
		);
		return;
	}

	if (pathname === "/api/settings" && req.method === "POST") {
		let body = "";
		req.on("data", (chunk) => (body += chunk));
		req.on("end", () => {
			try {
				const data = JSON.parse(body);
				if (data.apiKey) DEEPSEEK_API_KEY = data.apiKey.trim();
				if (data.model) CURRENT_MODEL = data.model;
				if (data.baseUrl) DEEPSEEK_BASE_URL = data.baseUrl.trim();
				if (data.thinking !== undefined) THINKING_ENABLED = !!data.thinking;
				if (data.openwaBaseUrl) OPENWA_BASE_URL = String(data.openwaBaseUrl).trim().replace(/\/$/, "");
				if (data.openwaApiKey) OPENWA_API_KEY = String(data.openwaApiKey).trim();
				if (data.openwaSession) OPENWA_SESSION = String(data.openwaSession).trim();

				// Persist to .env if desired
				try {
					const envPath = path.join(ROOT_DIR, ".env");
					const content = `# Updated by Vintoria Sales Agent UI\nDEEPSEEK_API_KEY=${DEEPSEEK_API_KEY}\nDEEPSEEK_BASE_URL=${DEEPSEEK_BASE_URL}\nPRIME_DEFAULT_MODEL=${CURRENT_MODEL}\nPRIME_THINKING_LEVEL=${THINKING_ENABLED ? "high" : "off"}\nPORT=${PORT}\nOPENWA_BASE_URL=${OPENWA_BASE_URL}\nOPENWA_API_KEY=${OPENWA_API_KEY}\nOPENWA_SESSION=${OPENWA_SESSION}\n`;
					fs.writeFileSync(envPath, content, "utf-8");
				} catch (e) {
					console.error("Failed writing .env:", e.message);
				}

				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ success: true, currentModel: CURRENT_MODEL, hasKey: true }));
			} catch (err) {
				res.writeHead(400, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: err.message }));
			}
		});
		return;
	}

	if (pathname === "/api/test-key" && req.method === "POST") {
		let body = "";
		req.on("data", (chunk) => (body += chunk));
		req.on("end", async () => {
			try {
				const data = JSON.parse(body || "{}");
				const keyToTest = (data.apiKey || DEEPSEEK_API_KEY || "").trim();
				const baseUrl = (data.baseUrl || DEEPSEEK_BASE_URL || "https://api.deepseek.com").trim();

				const testRes = await fetch(`${baseUrl}/models`, {
					headers: { Authorization: `Bearer ${keyToTest}` },
				});

				if (!testRes.ok) {
					const errText = await testRes.text();
					res.writeHead(testRes.status, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ success: false, error: errText }));
					return;
				}

				const result = await testRes.json();
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ success: true, models: result.data || [] }));
			} catch (err) {
				res.writeHead(500, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ success: false, error: err.message }));
			}
		});
		return;
	}

	if (pathname === "/api/files" && req.method === "GET") {
		try {
			function getTree(dir, depth = 0) {
				if (depth > 2) return [];
				const entries = fs.readdirSync(dir, { withFileTypes: true });
				const results = [];
				for (const ent of entries) {
					if (ent.name.startsWith(".git") || ent.name === "node_modules" || ent.name === "dist") continue;
					const full = path.join(dir, ent.name);
					const rel = path.relative(ROOT_DIR, full).replace(/\\/g, "/");
					if (ent.isDirectory()) {
						results.push({ name: ent.name, path: rel, type: "dir", children: getTree(full, depth + 1) });
					} else {
						results.push({ name: ent.name, path: rel, type: "file" });
					}
				}
				return results;
			}
			const tree = getTree(ROOT_DIR);
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ root: ROOT_DIR, tree }));
		} catch (err) {
			res.writeHead(500, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: err.message }));
		}
		return;
	}

	if (pathname === "/api/file" && req.method === "GET") {
		const relPath = parsedUrl.searchParams.get("path");
		if (!relPath) {
			res.writeHead(400, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "Missing path parameter" }));
			return;
		}
		const fullPath = path.resolve(ROOT_DIR, relPath);
		if (!fs.existsSync(fullPath)) {
			res.writeHead(404, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "File not found" }));
			return;
		}
		try {
			const content = fs.readFileSync(fullPath, "utf-8");
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ path: relPath, content }));
		} catch (e) {
			res.writeHead(500, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: e.message }));
		}
		return;
	}

	if (pathname === "/api/openwa/qr" && req.method === "GET") {
		(async () => {
			try {
				if (!OPENWA_API_KEY) { res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "OPENWA_API_KEY not configured on server" })); return; }
				const session = parsedUrl.searchParams.get("session") || OPENWA_SESSION;
				const list = await openwaFetch("/sessions");
				const arr = Array.isArray(list) ? list : list.sessions || list.data || [];
				const hit = (Array.isArray(arr) ? arr : []).find((s) => (s.name || s.id) === session || s.id === session);
				if (!hit) { res.writeHead(404, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: `No session '${session}'` })); return; }
				const status = hit.status || "unknown";
				if (status === "ready" || status === "READY" || status === "connected") {
					res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
					res.end(`<html><body style="font-family:sans-serif;text-align:center;padding-top:60px"><h2>Session '${session}' is already linked (READY).</h2><p>No QR needed. Close this tab and tell the agent to proceed.</p></body></html>`);
					return;
				}
				const sid = hit.id || hit.sessionId || session;
				const q = await openwaFetch(`/sessions/${sid}/qr`);
				const dataUrl = q.qrCode || q.qr || "";
				const m = String(dataUrl).match(/^data:image\/png;base64,(.+)$/s);
				if (!m) { res.writeHead(502, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "QR not available yet, refresh in 15s", status })); return; }
				const buf = Buffer.from(m[1], "base64");
				res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "no-store", "Content-Length": buf.length });
				res.end(buf);
			} catch (e) {
				res.writeHead(502, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: e.message }));
			}
		})();
		return;
	}

	if (pathname === "/api/openwa/qr-page" && req.method === "GET") {
		const session = parsedUrl.searchParams.get("session") || OPENWA_SESSION;
		res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
		res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Scan WhatsApp QR - ${session}</title></head><body style="font-family:sans-serif;text-align:center;background:#070a12;color:#e8eef7"><h2 style="margin-top:32px">Scan to link <b>${session}</b></h2><p>Use your DEDICATED WhatsApp number (never your primary). QR rotates ~60s — page auto-refreshes.</p><img id="qr" src="/api/openwa/qr?session=${encodeURIComponent(session)}" style="width:min(78vw,340px);border:8px solid #fff;border-radius:12px" onerror="document.getElementById('msg').textContent='QR not ready yet — retrying...'"><p id="msg"></p><script>setTimeout(()=>location.reload(),45000)</script></body></html>`);
		return;
	}

	if (pathname === "/api/tools/bash" && req.method === "POST") {
		let body = "";
		req.on("data", (chunk) => (body += chunk));
		req.on("end", async () => {
			try {
				const { command } = JSON.parse(body);
				const result = await executeTool("bash", { command });
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify(result));
			} catch (err) {
				res.writeHead(500, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ success: false, output: err.message }));
			}
		});
		return;
	}

	// Static files serving
	let filePath = path.join(PUBLIC_DIR, pathname === "/" ? "index.html" : pathname);
	if (!fs.existsSync(filePath)) {
		filePath = path.join(PUBLIC_DIR, "index.html");
	}

	const ext = path.extname(filePath).toLowerCase();
	const contentType = MIME_TYPES[ext] || "application/octet-stream";

	fs.readFile(filePath, (err, content) => {
		if (err) {
			res.writeHead(404, { "Content-Type": "text/plain" });
			res.end("404 Not Found");
		} else {
			res.writeHead(200, { "Content-Type": contentType });
			res.end(content);
		}
	});
});

// WebSocket Server
const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
	let currentController = null;
	const sessionId = "sess_" + Math.random().toString(36).substring(2, 9);
	let messageHistory = [];

	activeSessions.set(sessionId, { ws, messageHistory });

	ws.send(
		JSON.stringify({
			type: "connected",
			sessionId,
			model: CURRENT_MODEL,
			provider: "deepseek",
			baseUrl: DEEPSEEK_BASE_URL,
			hasKey: !!DEEPSEEK_API_KEY,
		}),
	);

	ws.on("message", async (data) => {
		try {
			const payload = JSON.parse(data.toString());

			if (payload.type === "abort") {
				if (currentController) {
					currentController.abort();
					currentController = null;
				}
				ws.send(JSON.stringify({ type: "aborted" }));
				return;
			}

			if (payload.type === "new_session") {
				messageHistory = [];
				ws.send(JSON.stringify({ type: "session_cleared", sessionId }));
				return;
			}

			if (payload.type === "prompt") {
				const userText = payload.message || "";
				const selectedModel = payload.model || CURRENT_MODEL;
				const isReasoner = selectedModel.includes("reasoner") || selectedModel.includes("r1");
				const allowTools = payload.tools !== false;

				messageHistory.push({ role: "user", content: userText });

				// Notify start
				ws.send(
					JSON.stringify({
						type: "agent_start",
						model: selectedModel,
						isReasoner,
					}),
				);

				currentController = new AbortController();
				const startTime = Date.now();
				let thinkingStartTime = Date.now();
				let accumulatedThinking = "";
				let accumulatedText = "";

				const systemPrompt =
					payload.systemPrompt ||
					`You are Vintoria Sales Agent, an autonomous Maps-to-WhatsApp sales prospector powered by DeepSeek. You speak English + Hindi/Hinglish (user may mix). Always reply in the user's language.

CRITICAL: You have DIRECT tool access. NEVER say "I cannot run commands". ALWAYS execute via tools immediately, chain calls across turns.

TOOLS:
- gmaps_scrape {queries[], depth 1-2 first, format csv|json, email?, lang?} -> starts Docker scrape, returns jobId. Query format: "business in City, Country" one per line (e.g. "dentists in Berlin, Germany"). For broad city coverage expand neighborhoods (Mitte, Kreuzberg...). CSV columns: title,category,phone,website,address,rating. JSON key for website is web_site.
- gmaps_status {jobId} -> poll every 30-60s. NEVER restart a running job. First poll after 30s.
- gmaps_results {jobId, filter_no_website?, limit?} -> read leads. filter_no_website=true gives only businesses with empty website. Report total + with_phone counts, preview max 20.
- openwa_status {session?} -> MUST call before any send. If session not READY, tell user to scan QR at OpenWA dashboard (http://localhost:2785) and stop.
- openwa_check {numbers[], session?} -> validate numbers exist on WhatsApp before first outreach (max 20/call).
- openwa_send {to, text, session?} -> single send. Phone auto-normalized to chatId. Max 4096 chars.
- openwa_bulk {messages[{to,text,variables}], session?, delayMs default 3000} -> max 100/batch, {{variables}} templating, throttled.
- bash/read_file/write_file/list_files/search_code -> general workspace work.

QR PAIRING (do this before any first send):
1. openwa_status. If READY -> proceed. If qr_ready/created/need_qr -> call openwa_qr.
2. Give user the QR page link (/api/openwa/qr-page?session=NAME on THIS UI host) + dedicated-number warning + 60s rotation note. NEVER paste base64.
3. After they scan, re-check openwa_status until READY. Do NOT attempt sends while not READY.

WORKFLOWS:
A) "find X without website" (e.g. "go to google maps find dentists in Mumbai that dont have website"):
1. Parse business type + city. If missing, ask ONE short question.
2. Build 1 validation query, call gmaps_scrape depth=1. Tell user validation started.
3. Poll gmaps_status until finished. If zero results, expand neighborhoods/lang and retry.
4. Call gmaps_results filter_no_website=true limit=20. Report: total scraped, no-website count, with-phone count + 20-row preview (name | phone | address).
5. Offer next step: "Say 'send WhatsApp' with your message to outreach."
B) "send WhatsApp ..." :
1. Need: lead set (jobId or pasted numbers) + message text + session (default vintoria-sales). If message missing, ask for it. If leads missing, ask for jobId/numbers.
2. openwa_status first. Not READY -> stop with QR instructions.
3. openwa_check on numbers (new contacts only). Drop NOT-ON-WHATSAPP, report dropped.
4. Confirm preview with user for bulk >5: show first 3 rendered messages + count. On "yes/send", openwa_send (<=3) or openwa_bulk (>3, delayMs 3000-5000).
5. Report messageIds/batchId + failures. Never claim delivery (201 = handed to client, not delivered).
C) Any other task: use bash/files tools directly, be concise.

GUARDRAILS:
- Start conservative (depth 1-2, no email). Add -email/extra depth only on request.
- Filtering "no website" = website field empty in THIS crawl, never claim business truly has no site.
- Phone: keep digits + country code; never invent numbers.
- Compliance: warm numbers only, max ~20 msgs/day/new session unless user confirms, delay 3-5s between sends, no cold-blast of hundreds on day one. Warn once per bulk.
- Secrets: NEVER print/proxy/API keys, QR tokens, or full .env. Proxy creds only via terminal, never chat.
- Hinglish OK. Keep answers short, tables for leads, no fluff.`;

				let continueExecution = true;
				let currentTurn = 0;
				const maxTurns = 15;

				while (continueExecution && currentTurn < maxTurns) {
					currentTurn++;
					let assistantMessage = { role: "assistant", content: "" };
					let toolCalls = [];

					const reqMessages = [{ role: "system", content: systemPrompt }, ...messageHistory];

					const effectiveMessages = reqMessages;

					const reqBody = {
						model: selectedModel,
						messages: effectiveMessages,
						stream: true,
					};

					if (allowTools) {
						reqBody.tools = TOOLS_DEFINITIONS;
						reqBody.tool_choice = "auto";
					}

					if (payload.temperature !== undefined) {
						reqBody.temperature = payload.temperature;
					}

					let response;
					try {
						response = await fetch(`${DEEPSEEK_BASE_URL}/chat/completions`, {
							method: "POST",
							headers: {
								"Content-Type": "application/json",
								Authorization: `Bearer ${DEEPSEEK_API_KEY}`,
							},
							body: JSON.stringify(reqBody),
							signal: currentController.signal,
						});
					} catch (fetchErr) {
						if (fetchErr.name === "AbortError") {
							ws.send(JSON.stringify({ type: "aborted" }));
							return;
						}
						throw fetchErr;
					}

					if (!response.ok) {
						const errBody = await response.text();
						ws.send(JSON.stringify({ type: "error", error: `DeepSeek API Error (${response.status}): ${errBody}` }));
						return;
					}

					// Stream response SSE
					const reader = response.body.getReader();
					const decoder = new TextDecoder();
					let buffer = "";

					while (true) {
						const { done, value } = await reader.read();
						if (done) break;

						buffer += decoder.decode(value, { stream: true });
						const lines = buffer.split("\n");
						buffer = lines.pop() || "";

						for (const line of lines) {
							const trimmed = line.trim();
							if (!trimmed || !trimmed.startsWith("data:")) continue;
							if (trimmed === "data: [DONE]") continue;

							try {
								const parsed = JSON.parse(trimmed.slice(5).trim());
								const delta = parsed.choices?.[0]?.delta;
								if (!delta) continue;

								// DeepSeek Reasoning delta
								if (delta.reasoning_content) {
									accumulatedThinking += delta.reasoning_content;
									ws.send(
										JSON.stringify({
											type: "thinking_delta",
											delta: delta.reasoning_content,
											accumulated: accumulatedThinking,
											elapsedMs: Date.now() - thinkingStartTime,
										}),
									);
								}

								// Text content delta
								if (delta.content) {
									accumulatedText += delta.content;
									assistantMessage.content += delta.content;
									ws.send(
										JSON.stringify({
											type: "text_delta",
											delta: delta.content,
											accumulated: accumulatedText,
										}),
									);
								}

								// Tool calls delta
								if (delta.tool_calls) {
									for (const tc of delta.tool_calls) {
										const idx = tc.index || 0;
										if (!toolCalls[idx]) {
											toolCalls[idx] = {
												id: tc.id || `call_${Math.random().toString(36).slice(2, 9)}`,
												type: "function",
												function: { name: tc.function?.name || "", arguments: "" },
											};
										}
										if (tc.function?.name) toolCalls[idx].function.name = tc.function.name;
										if (tc.function?.arguments) toolCalls[idx].function.arguments += tc.function.arguments;
									}
								}
							} catch (parseErr) {
								// skip malformed chunk
							}
						}
					}

					// Process tool calls if any
					if (toolCalls.length > 0) {
						assistantMessage.tool_calls = toolCalls;
						messageHistory.push(assistantMessage);

						for (const tc of toolCalls) {
							let parsedArgs = {};
							try {
								parsedArgs = JSON.parse(tc.function.arguments || "{}");
							} catch {
								parsedArgs = { raw: tc.function.arguments };
							}

							ws.send(
								JSON.stringify({
									type: "tool_start",
									callId: tc.id,
									tool: tc.function.name,
									args: parsedArgs,
								}),
							);

							const execResult = await executeTool(tc.function.name, parsedArgs);

							ws.send(
								JSON.stringify({
									type: "tool_end",
									callId: tc.id,
									tool: tc.function.name,
									result: execResult,
								}),
							);

							messageHistory.push({
								role: "tool",
								tool_call_id: tc.id,
								content: execResult.output,
							});
						}

						// Reset assistant text for next tool synthesis turn
						assistantMessage = { role: "assistant", content: "" };
					} else {
						// No more tool calls; we are done
						messageHistory.push(assistantMessage);
						continueExecution = false;
					}
				}

				const totalDuration = Date.now() - startTime;
				ws.send(
					JSON.stringify({
						type: "agent_end",
						durationMs: totalDuration,
						tokensEstimate: Math.round((accumulatedThinking.length + accumulatedText.length) / 3.8),
					}),
				);

				currentController = null;
			}
		} catch (err) {
			console.error("WS Error:", err);
			ws.send(JSON.stringify({ type: "error", error: err.message }));
			currentController = null;
		}
	});

	ws.on("close", () => {
		if (currentController) currentController.abort();
		activeSessions.delete(sessionId);
	});
});

server.listen(PORT, "0.0.0.0", () => {
	console.log(`
============================================================
  VINTORIA SALES AGENT - DEEPSEEK WEB UI
============================================================
  URL:       http://localhost:${PORT}
  Network:   http://0.0.0.0:${PORT}
  Model:     ${CURRENT_MODEL}
  Provider:  DeepSeek (api.deepseek.com)
  Status:    Ready with API Key configured
============================================================
`);
});
