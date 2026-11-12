const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");

const app = express();

const allowedOrigins = ["https://jimgold-1234.github.io"];

app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error("Origin not allowed by CORS."));
  },
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  optionsSuccessStatus: 204
}));

app.use(express.json({ limit: "1mb" }));

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

async function requireSignedIn(req, res, next) {
  try {
    const authorization = req.headers.authorization || "";
    if (!authorization.startsWith("Bearer ")) {
      return res.status(401).json({ error: "You must be signed in." });
    }

    const decoded = await auth.verifyIdToken(authorization.substring(7));
    req.user = {
      uid: decoded.uid,
      email: decoded.email || "",
      emailVerified: decoded.email_verified === true
    };
    return next();
  } catch (error) {
    console.error("Authentication error:", error.message);
    return res.status(401).json({ error: "Authentication failed." });
  }
}

function requireDeveloper(req, res, next) {
  if (
    req.user?.email?.toLowerCase() !== DEVELOPER_EMAIL.toLowerCase() ||
    req.user?.emailVerified !== true
  ) {
    return res.status(403).json({ error: "Not authorized." });
  }
  req.developerUid = req.user.uid;
  return next();
}

function requireString(value, field, maxLength = 200) {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) {
    const error = new Error(`Invalid ${field}.`);
    error.status = 400;
    throw error;
  }
  return value.trim();
}

function sendError(res, error, fallback) {
  console.error(fallback, error);
  return res.status(error.status || 500).json({
    error: error.status ? error.message : fallback
  });
}

app.get("/", (req, res) => {
  res.json({ success: true, service: "iCom Backend", status: "online" });
});

// Signed-in user conversation actions. Admin SDK writes are protected here
// by explicit membership and ownership checks because Admin SDK bypasses rules.
app.post("/conversations/action", requireSignedIn, async (req, res) => {
  try {
    const action = requireString(req.body?.action, "action", 40);
    const conversationId = requireString(req.body?.conversationId, "conversation ID");
    const ref = db.collection("conversations").doc(conversationId);
    const snapshot = await ref.get();

    if (!snapshot.exists) {
      return res.status(404).json({ error: "Conversation not found." });
    }

    const data = snapshot.data() || {};
    const uid = req.user.uid;
    const members = Array.isArray(data.members) ? data.members : [];
    const activeMembers = Array.isArray(data.activeMembers)
      ? data.activeMembers
      : members.slice();
    const isGroup = data.isGroup === true;

    if (!members.includes(uid)) {
      return res.status(403).json({ error: "You are not a member of this conversation." });
    }

    if (action === "leave") {
      if (isGroup && data.ownerUid === uid) {
        return res.status(400).json({
          error: "The group owner must transfer ownership or delete the group before leaving."
        });
      }

      if (isGroup) {
        const nextMembers = members.filter(memberUid => memberUid !== uid);
        const nextActive = activeMembers.filter(memberUid => memberUid !== uid);
        await ref.update({
          members: nextMembers,
          activeMembers: nextActive,
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
      } else {
        await ref.update({
          activeMembers: activeMembers.filter(memberUid => memberUid !== uid),
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
      }

      return res.json({ success: true, action });
    }

    if (!isGroup) {
      return res.status(400).json({ error: "This action is only available for group conversations." });
    }

    if (data.ownerUid !== uid) {
      return res.status(403).json({ error: "Only the group owner can perform this action." });
    }

    if (action === "rename") {
      const name = requireString(req.body?.name, "group name", 50);
      await ref.update({
        name,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      return res.json({ success: true, action, name });
    }

    if (action === "kick") {
      const memberUid = requireString(req.body?.memberUid, "member ID", 128);
      if (memberUid === uid) {
        return res.status(400).json({ error: "The group owner cannot remove themselves." });
      }
      if (!members.includes(memberUid)) {
        return res.status(404).json({ error: "That user is not a group member." });
      }

      const nextMembers = members.filter(value => value !== memberUid);
      const nextActive = activeMembers.filter(value => value !== memberUid);
      await ref.update({
        members: nextMembers,
        activeMembers: nextActive,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      return res.json({ success: true, action });
    }

    if (action === "transfer") {
      const newOwnerUid = requireString(req.body?.newOwnerUid, "new owner ID", 128);
      if (newOwnerUid === uid || !members.includes(newOwnerUid)) {
        return res.status(400).json({ error: "The new owner must be another current group member." });
      }
      await ref.update({
        ownerUid: newOwnerUid,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      return res.json({ success: true, action });
    }

    if (action === "delete") {
      await db.recursiveDelete(ref);
      return res.json({ success: true, action });
    }

    return res.status(400).json({ error: "Unknown conversation action." });
  } catch (error) {
    return sendError(res, error, "Unable to complete conversation action.");
  }
});

// Developer-only administration endpoints.
app.post("/admin/conversations", requireSignedIn, requireDeveloper, async (req, res) => {
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
    return res.json({ conversations });
  } catch (error) {
    return sendError(res, error, "Unable to list conversations.");
  }
});

app.post("/admin/conversation", requireSignedIn, requireDeveloper, async (req, res) => {
  try {
    const conversationId = requireString(req.body?.conversationId, "conversation ID");
    const conversationRef = db.collection("conversations").doc(conversationId);
    const conversationSnapshot = await conversationRef.get();
    if (!conversationSnapshot.exists) {
      return res.status(404).json({ error: "Conversation not found." });
    }

    const messagesSnapshot = await conversationRef.collection("messages")
      .orderBy("createdAt", "asc").limit(500).get();
    const messages = messagesSnapshot.docs.map(document => {
      const data = document.data();
      return {
        id: document.id,
        text: typeof data.text === "string" ? data.text : "",
        senderId: typeof data.senderId === "string" ? data.senderId : "",
        unsent: data.unsent === true
      };
    });
    return res.json({ messages });
  } catch (error) {
    return sendError(res, error, "Unable to load conversation messages.");
  }
});

app.post("/admin/delete-message", requireSignedIn, requireDeveloper, async (req, res) => {
  try {
    const conversationId = requireString(req.body?.conversationId, "conversation ID");
    const messageId = requireString(req.body?.messageId, "message ID");
    const conversationRef = db.collection("conversations").doc(conversationId);
    const conversationSnapshot = await conversationRef.get();
    if (!conversationSnapshot.exists) {
      return res.status(404).json({ error: "Conversation not found." });
    }

    const messageRef = conversationRef.collection("messages").doc(messageId);
    const messageSnapshot = await messageRef.get();
    if (!messageSnapshot.exists) {
      return res.status(404).json({ error: "Message not found." });
    }
    await messageRef.delete();
    return res.json({ success: true });
  } catch (error) {
    return sendError(res, error, "Unable to delete message.");
  }
});

app.post("/admin/clear-message-requests", requireSignedIn, requireDeveloper, async (req, res) => {
  try {
    const requestsRef = db.collection("messageRequests");
    const snapshot = await requestsRef.get();
    const deletedCount = snapshot.size;
    if (deletedCount > 0) await db.recursiveDelete(requestsRef);
    return res.json({ success: true, deletedCount });
  } catch (error) {
    return sendError(res, error, "Unable to clear message requests.");
  }
});

app.post("/admin/delete-conversation", requireSignedIn, requireDeveloper, async (req, res) => {
  try {
    const conversationId = requireString(req.body?.conversationId, "conversation ID");
    const ref = db.collection("conversations").doc(conversationId);
    const snapshot = await ref.get();
    if (!snapshot.exists) {
      return res.status(404).json({ error: "Conversation not found." });
    }
    await db.recursiveDelete(ref);
    return res.json({ success: true });
  } catch (error) {
    return sendError(res, error, "Unable to delete conversation.");
  }
});

app.post("/admin/reset-all-data", requireSignedIn, requireDeveloper, async (req, res) => {
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
      const userRef = db.collection("users").doc(userDoc.id);
      await Promise.all([
        db.recursiveDelete(userRef.collection("blocks")),
        db.recursiveDelete(userRef.collection("conversationPreferences")),
        db.recursiveDelete(userRef.collection("hiddenMessages"))
      ]);
    }

    return res.json({
      success: true,
      message: "Communication data has been reset. User accounts and profiles were preserved."
    });
  } catch (error) {
    return sendError(res, error, "Unable to reset communication data.");
  }
});

app.use((error, req, res, next) => {
  console.error("Unhandled backend error:", error);
  if (res.headersSent) return next(error);
  return res.status(500).json({ error: "Internal server error." });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`iCom backend listening on port ${PORT}`);
});
