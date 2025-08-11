const express = require("express");
const bodyParser = require("body-parser");
const { google } = require("googleapis");
const nodemailer = require("nodemailer"); // For sending emails, but we'll use Gmail API primarily
const cron = require("node-cron");
const fs = require("fs");
const path = require("path");
const cors = require("cors");
const { v4: uuidv4 } = require("uuid");

// In-memory data stores (replace with DB for production)
let templates = [];
let campaigns = [];
let contactLists = [];
let emailTracking = [];
let appointments = []; // For scheduled follow-ups

// Google API setup
const SCOPES = [
	"https://www.googleapis.com/auth/gmail.send",
	"https://www.googleapis.com/auth/gmail.readonly"
];
const TOKEN_PATH = path.join(__dirname, "token.json");
const CREDENTIALS_PATH = path.join(__dirname, "credentials.json");

// Load client secrets
function loadCredentials() {
	const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH));
	return credentials;
}

// Authorize Google API
async function authorize() {
	const {
		client_secret,
		client_id,
		redirect_uris
	} = loadCredentials().installed;
	const oAuth2Client = new google.auth.OAuth2(
		client_id,
		client_secret,
		redirect_uris[0]
	);

	if (fs.existsSync(TOKEN_PATH)) {
		const token = fs.readFileSync(TOKEN_PATH);
		oAuth2Client.setCredentials(JSON.parse(token));
	} else {
		// For initial auth, run getNewToken(oAuth2Client) manually and save token
		console.error("No token found. Run authorization flow.");
		process.exit(1);
	}
	return oAuth2Client;
}

// Function to get new token (run once)
async function getNewToken(oAuth2Client) {
	const authUrl = oAuth2Client.generateAuthUrl({
		access_type: "offline",
		scope: SCOPES
	});
	console.log("Authorize this app by visiting this url:", authUrl);
	// Use a local server or manual input to get code, then:
	// const { tokens } = await oAuth2Client.getToken(code);
	// fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens));
}

// Gmail API client
let gmail;
authorize().then((auth) => {
	gmail = google.gmail({ version: "v1", auth });
});

// App setup
const app = express();
app.use(bodyParser.json());
app.use(cors({ origin: "http://localhost" })); // Adjust for your frontend origin

// Templates API
app.get("/api/templates", (req, res) => res.json(templates));
app.post("/api/templates", (req, res) => {
	const template = {
		id: uuidv4(),
		...req.body,
		created: new Date().toISOString()
	};
	templates.push(template);
	res.json(template);
});
app.delete("/api/templates/:id", (req, res) => {
	templates = templates.filter((t) => t.id !== req.params.id);
	res.sendStatus(204);
});

// Contact Lists API
app.get("/api/contact-lists", (req, res) => res.json(contactLists));
app.post("/api/contact-lists", (req, res) => {
	const list = { id: uuidv4(), ...req.body, created: new Date().toISOString() };
	contactLists.push(list);
	res.json(list);
});
app.delete("/api/contact-lists/:id", (req, res) => {
	contactLists = contactLists.filter((l) => l.id !== req.params.id);
	res.sendStatus(204);
});

// Campaigns API
app.get("/api/campaigns", (req, res) => {
	// Populate with relations
	const populated = campaigns.map((c) => ({
		...c,
		template: templates.find((t) => t.id === c.templateId),
		contactList: contactLists.find((l) => l.id === c.contactListId)
	}));
	res.json(populated);
});
app.post("/api/campaigns", async (req, res) => {
	const campaign = {
		id: uuidv4(),
		status: req.body.sendType === "schedule" ? "scheduled" : "sent",
		created: new Date().toISOString(),
		...req.body
	};
	campaigns.push(campaign);
	if (req.body.sendType === "now") {
		await sendCampaign(campaign);
	} else if (req.body.sendType === "schedule") {
		scheduleCampaign(campaign);
	}
	res.json(campaign);
});
app.delete("/api/campaigns/:id", (req, res) => {
	campaigns = campaigns.filter((c) => c.id !== req.params.id);
	res.sendStatus(204);
});

// Stats API
app.get("/api/stats", (req, res) => {
	const sent = emailTracking.filter((t) => t.status === "sent").length;
	const opened = emailTracking.filter((t) => t.status === "opened").length;
	const replied = emailTracking.filter((t) => t.status === "replied").length;
	const scheduled = campaigns.filter((c) => c.status === "scheduled").length;
	res.json({ sent, opened, replied, scheduled });
});

// Recent Activity API
app.get("/api/recent-activity", (req, res) => {
	const activity = emailTracking
		.sort((a, b) => new Date(b.sentAt) - new Date(a.sentAt))
		.slice(0, 10)
		.map((t) => ({
			...t,
			campaignName: campaigns.find((c) => c.id === t.campaignId)?.name || "Unknown"
		}));
	res.json(activity);
});

// Tracking endpoint for opens (called by pixel in email)
app.get("/api/track/open/:trackingId", (req, res) => {
	const tracking = emailTracking.find((t) => t.id === req.params.trackingId);
	if (
		tracking &&
		tracking.status !== "opened" &&
		tracking.status !== "replied"
	) {
		tracking.status = "opened";
		tracking.openedAt = new Date().toISOString();
	}
	// Return 1x1 transparent pixel
	res.set("Content-Type", "image/gif");
	res.send(
		Buffer.from(
			"R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
			"base64"
		)
	);
});

// Function to send campaign emails
async function sendCampaign(campaign) {
	const template = templates.find((t) => t.id === campaign.templateId);
	const contactList = contactLists.find((l) => l.id === campaign.contactListId);
	for (const email of contactList.emails) {
		const trackingId = uuidv4();
		const trackingPixel = `<img src="http://localhost:3000/api/track/open/${trackingId}" alt="" width="1" height="1">`;
		const content = `${template.content}${trackingPixel}`;
		await sendEmail(email, template.subject, content);
		emailTracking.push({
			id: trackingId,
			campaignId: campaign.id,
			email,
			status: "sent",
			sentAt: new Date().toISOString(),
			openedAt: null,
			repliedAt: null
		});
	}
	campaign.sent = new Date().toISOString();
	campaign.status = "sent";
}

// Send email via Gmail API
async function sendEmail(to, subject, html) {
	const message = [
		`To: ${to}`,
		'Content-Type: text/html; charset="UTF-8"',
		`Subject: ${subject}`,
		"",
		html
	].join("\n");

	const encodedMessage = Buffer.from(message)
		.toString("base64")
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");

	await gmail.users.messages.send({
		userId: "me",
		resource: { raw: encodedMessage }
	});
}

// Schedule campaign
function scheduleCampaign(campaign) {
	const scheduleDate = new Date(campaign.scheduleTime);
	cron.schedule(
		`${scheduleDate.getMinutes()} ${scheduleDate.getHours()} ${scheduleDate.getDate()} ${
			scheduleDate.getMonth() + 1
		} *`,
		async () => {
			await sendCampaign(campaign);
		},
		{ timezone: "UTC" }
	);
}

// Poll for replies (run periodically)
cron.schedule("*/5 * * * *", async () => {
	// Every 5 minutes
	try {
		const res = await gmail.users.messages.list({ userId: "me", q: "is:unread" });
		for (const message of res.data.messages || []) {
			const msg = await gmail.users.messages.get({ userId: "me", id: message.id });
			const from = msg.data.payload.headers.find((h) => h.name === "From")?.value;
			const replyToCampaign = emailTracking.find(
				(t) => t.email === from && !t.repliedAt
			);
			if (replyToCampaign) {
				replyToCampaign.status = "replied";
				replyToCampaign.repliedAt = new Date().toISOString();
				// Collect info from reply (simple extraction example)
				const body = Buffer.from(
					msg.data.payload.parts?.[0]?.body?.data || "",
					"base64"
				).toString();
				console.log(`Collected from ${from}: ${body}`);
				// Schedule follow-up (example: add to appointments)
				appointments.push({
					contact: from,
					date: new Date(Date.now() + 86400000).toISOString(),
					note: "Follow-up call"
				}); // Next day
			}
		}
	} catch (err) {
		console.error("Error polling replies:", err);
	}
});

// Appointments API (for scheduling/follow-ups)
app.get("/api/appointments", (req, res) => res.json(appointments));

app.listen(3000, () => console.log("Server running on http://localhost:3000"));
