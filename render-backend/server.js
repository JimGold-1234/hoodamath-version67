const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");

const app = express();

// GitHub Pages origin (origin values must NOT include /iCom/ or a trailing path).
const allowedOrigins = [
  "https://jimgold-1234.github.io"
];

app.use(cors({
  origin: function (origin, callback) {
    // Allow requests without an Origin header for health checks/server-to-server use.
    if (!origin || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error("Origin not allowed by CORS."));
  },
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  optionsSuccessStatus: 204
}));

// The cors middleware above automatically answers browser OPTIONS preflight requests.

app.use(express.json({ limit: "1mb" }));

// Initialize Firebase Admin using Render environment variables.
if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
  throw new Error("Missing FIREBASE_SERVICE_ACCOUNT environment variable.");
}

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();
const auth = admin.auth();

const DEVELOPER_EMAIL = "jimgoldbloomyt@gmail.com";

async function requireDeveloper(req, res, next) {
  try {
    const authorization = req.headers.authorization || "";

    if (!authorization.startsWith("Bearer ")) {
      return res.status(401).json({ error: "You must be signed in." });
    }

    const token = authorization.substring(7);
    const decoded = await auth.verifyIdToken(token);

    if (
      decoded.email?.toLowerCase() !== DEVELOPER_EMAIL.toLowerCase() ||
      decoded.email_verified !== true
    ) {
      return res.status(403).json({ error: "Not authorized." });
    }

    req.developerUid = decoded.uid;
    next();
  } catch (error) {
    console.error("Authentication error:", error.message);
    return res.status(401).json({ error: "Authentication failed." });
  }
}

function requireString(value, field) {
  if (typeof value !== "string" || !value.trim() || value.length > 200) {
    const error = new Error(`Invalid ${field}.`);
    error.status = 400;
    throw error;
  }

  return value.trim();
}

// Health check
app.get("/", (req, res) => {
  res.json({
    success: true,
    service: "iCom Backend",
    status: "online"
  });
});

// VIEW ALL CHATS
app.post("/admin/conversations", requireDeveloper, async (req, res) => {
  try {
    const snapshot = await db.collection("conversations").get();

    const conversations = snapshot.docs.map(document => {
      const data = document.data();

      return {
        id: document.id,
        name: data.name || "",
        isGroup: data.isGroup === true,
        members: data.members || [],
        ownerUid: data.ownerUid || "",
        lastMessage: data.lastMessage || "",
        updatedAt: data.updatedAt || null
      };
    });

    res.json({ conversations });
  } catch (error) {
    console.error("List conversations error:", error);
    res.status(500).json({ error: "Unable to list conversations." });
  }
});

// DELETE ONE CONVERSATION
app.post("/admin/delete-conversation", requireDeveloper, async (req, res) => {
  try {
    const conversationId = requireString(
      req.body?.conversationId,
      "conversation ID"
    );

    const ref = db.collection("conversations").doc(conversationId);
    const snapshot = await ref.get();

    if (!snapshot.exists) {
      return res.status(404).json({ error: "Conversation not found." });
    }

    await db.recursiveDelete(ref);

    res.json({ success: true });
  } catch (error) {
    console.error("Delete conversation error:", error);
    res.status(error.status || 500).json({
      error: error.status ? error.message : "Unable to delete conversation."
    });
  }
});

// CLEAR ALL COMMUNICATION DATA
app.post("/admin/reset-all-data", requireDeveloper, async (req, res) => {
  try {
    if (req.body?.confirmation !== "RESET ALL DATA") {
      return res.status(400).json({
        error: 'Exact confirmation "RESET ALL DATA" is required.'
      });
    }

    await db.recursiveDelete(db.collection("conversations"));
    await db.recursiveDelete(db.collection("messageRequests"));

    const usersSnapshot = await db.collection("users").get();

    for (const userDoc of usersSnapshot.docs) {
      const uid = userDoc.id;

      await Promise.all([
        db.recursiveDelete(
          db.collection("users").doc(uid).collection("blocks")
        ),
        db.recursiveDelete(
          db.collection("users").doc(uid).collection("conversationPreferences")
        ),
        db.recursiveDelete(
          db.collection("users").doc(uid).collection("hiddenMessages")
        )
      ]);
    }

    res.json({
      success: true,
      message: "Communication data has been reset. User accounts and profiles were preserved."
    });
  } catch (error) {
    console.error("Reset data error:", error);
    res.status(500).json({ error: "Unable to reset communication data." });
  }
});

// General error handler
app.use((error, req, res, next) => {
  console.error(error);
  res.status(500).json({ error: "Internal server error." });
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`iCom backend listening on port ${PORT}`);
});
