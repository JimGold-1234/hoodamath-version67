
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");

admin.initializeApp();

const db = admin.firestore();
const auth = admin.auth();

const DEVELOPER_EMAIL = "jimgoldbloomyt@gmail.com";

// ------------------------------
// AUTHORIZATION
// ------------------------------

function requireSignedIn(request) {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "You must be signed in.");
  }

  return request.auth.uid;
}

function requireDeveloper(request) {
  const uid = requireSignedIn(request);
  const email = request.auth.token.email;
  const emailVerified = request.auth.token.email_verified === true;

  if (
    email !== DEVELOPER_EMAIL ||
    !emailVerified
  ) {
    throw new HttpsError(
      "permission-denied",
      "You are not authorized to use this developer function."
    );
  }

  return uid;
}

function requireString(value, field, maxLength = 200) {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > maxLength
  ) {
    throw new HttpsError(
      "invalid-argument",
      `Invalid ${field}.`
    );
  }

  return value.trim();
}

async function getConversation(conversationId) {
  const id = requireString(conversationId, "conversation ID");
  const ref = db.collection("conversations").doc(id);
  const snapshot = await ref.get();

  if (!snapshot.exists) {
    throw new HttpsError("not-found", "Conversation not found.");
  }

  return { ref, data: snapshot.data() };
}

async function requireGroupOwner(uid, conversationId) {
  const conversation = await getConversation(conversationId);

  if (
    conversation.data.isGroup !== true ||
    conversation.data.ownerUid !== uid
  ) {
    throw new HttpsError(
      "permission-denied",
      "Only the group owner can perform this action."
    );
  }

  return conversation;
}

async function addSystemMessage(conversationRef, text) {
  const messageRef = conversationRef.collection("messages").doc();

  await messageRef.set({
    senderId: "system",
    text,
    type: "system",
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  });

  await conversationRef.update({
    lastMessage: text,
    lastSenderId: "system",
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  });
}

// ------------------------------
// MESSAGE REQUESTS
// ------------------------------

exports.acceptMessageRequest = onCall(async (request) => {
  const uid = requireSignedIn(request);

  const requestId = requireString(
    request.data?.requestId,
    "request ID"
  );

  const status = request.data?.status;

  if (!["accepted", "rejected"].includes(status)) {
    throw new HttpsError(
      "invalid-argument",
      "Status must be accepted or rejected."
    );
  }

  const requestRef = db.collection("messageRequests").doc(requestId);

  return db.runTransaction(async (transaction) => {
    const requestSnapshot = await transaction.get(requestRef);

    if (!requestSnapshot.exists) {
      throw new HttpsError("not-found", "Message request not found.");
    }

    const requestData = requestSnapshot.data();

    if (requestData.recipientId !== uid) {
      throw new HttpsError(
        "permission-denied",
        "You cannot respond to this request."
      );
    }

    if (requestData.status !== "pending") {
      throw new HttpsError(
        "failed-precondition",
        "This request has already been handled."
      );
    }

    transaction.update(requestRef, {
      status,
      respondedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    if (status === "rejected") {
      return { success: true, status };
    }

    const senderId = requestData.senderId;

    if (!senderId || senderId === uid) {
      throw new HttpsError(
        "failed-precondition",
        "The message request contains invalid user information."
      );
    }

    const members = [senderId, uid].sort();
    const conversationId = members.join("_");
    const conversationRef = db
      .collection("conversations")
      .doc(conversationId);

    const conversationSnapshot = await transaction.get(conversationRef);

    const conversationData = {
      members,
      activeMembers: members,
      isGroup: false,
      createdAt: conversationSnapshot.exists
        ? conversationSnapshot.data().createdAt
        : admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      lastMessage: conversationSnapshot.exists
        ? conversationSnapshot.data().lastMessage || ""
        : "",
      lastSenderId: conversationSnapshot.exists
        ? conversationSnapshot.data().lastSenderId || ""
        : ""
    };

    transaction.set(conversationRef, conversationData, { merge: true });

    return {
      success: true,
      status,
      conversationId
    };
  });
});

// ------------------------------
// LEAVING CONVERSATIONS
// ------------------------------

exports.leavePrivateConversation = onCall(async (request) => {
  const uid = requireSignedIn(request);

  const conversationId = requireString(
    request.data?.conversationId,
    "conversation ID"
  );

  const { ref, data } = await getConversation(conversationId);

  if (data.isGroup === true) {
    throw new HttpsError(
      "failed-precondition",
      "This is a group conversation."
    );
  }

  if (!Array.isArray(data.members) || !data.members.includes(uid)) {
    throw new HttpsError(
      "permission-denied",
      "You are not part of this conversation."
    );
  }

  const activeMembers = Array.isArray(data.activeMembers)
    ? data.activeMembers
    : data.members;

  if (!activeMembers.includes(uid)) {
    throw new HttpsError(
      "failed-precondition",
      "You have already left this conversation."
    );
  }

  const remainingMembers = activeMembers.filter(
    (memberUid) => memberUid !== uid
  );

  await ref.update({
    activeMembers: remainingMembers,
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  });

  return { success: true };
});

exports.leaveGroupConversation = onCall(async (request) => {
  const uid = requireSignedIn(request);

  const conversationId = requireString(
    request.data?.conversationId,
    "conversation ID"
  );

  const { ref, data } = await getConversation(conversationId);

  if (data.isGroup !== true) {
    throw new HttpsError(
      "failed-precondition",
      "This is not a group conversation."
    );
  }

  if (!Array.isArray(data.members) || !data.members.includes(uid)) {
    throw new HttpsError(
      "permission-denied",
      "You are not a member of this group."
    );
  }

  if (data.ownerUid === uid) {
    throw new HttpsError(
      "failed-precondition",
      "Transfer ownership before leaving the group."
    );
  }

  await ref.update({
    members: data.members.filter((memberUid) => memberUid !== uid),
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  });

  await addSystemMessage(
    ref,
    "A member left the group."
  );

  return { success: true };
});

// ------------------------------
// GROUP MANAGEMENT
// ------------------------------

exports.renameGroupConversation = onCall(async (request) => {
  const uid = requireSignedIn(request);

  const conversationId = requireString(
    request.data?.conversationId,
    "conversation ID"
  );

  const name = requireString(request.data?.name, "group name", 50);

  const { ref } = await requireGroupOwner(uid, conversationId);

  await ref.update({
    name,
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  });

  await addSystemMessage(ref, `The group was renamed to ${name}.`);

  return { success: true };
});

exports.kickGroupMember = onCall(async (request) => {
  const uid = requireSignedIn(request);

  const conversationId = requireString(
    request.data?.conversationId,
    "conversation ID"
  );

  const memberUid = requireString(
    request.data?.memberUid,
    "member UID"
  );

  const { ref, data } = await requireGroupOwner(uid, conversationId);

  if (memberUid === uid) {
    throw new HttpsError(
      "invalid-argument",
      "You cannot remove yourself with this action."
    );
  }

  if (!data.members.includes(memberUid)) {
    throw new HttpsError(
      "not-found",
      "That user is not in the group."
    );
  }

  await ref.update({
    members: data.members.filter((id) => id !== memberUid),
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  });

  await addSystemMessage(ref, "A member was removed from the group.");

  return { success: true };
});

exports.transferGroupOwnership = onCall(async (request) => {
  const uid = requireSignedIn(request);

  const conversationId = requireString(
    request.data?.conversationId,
    "conversation ID"
  );

  const newOwnerUid = requireString(
    request.data?.newOwnerUid,
    "new owner UID"
  );

  const { ref, data } = await requireGroupOwner(uid, conversationId);

  if (!data.members.includes(newOwnerUid)) {
    throw new HttpsError(
      "invalid-argument",
      "The new owner must already be a group member."
    );
  }

  await ref.update({
    ownerUid: newOwnerUid,
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  });

  await addSystemMessage(ref, "Group ownership was transferred.");

  return { success: true };
});

exports.deleteGroupConversation = onCall(async (request) => {
  const uid = requireSignedIn(request);

  const conversationId = requireString(
    request.data?.conversationId,
    "conversation ID"
  );

  const { ref } = await requireGroupOwner(uid, conversationId);

  await db.recursiveDelete(ref);

  return { success: true };
});

// ------------------------------
// DEVELOPER: USER MANAGEMENT
// ------------------------------

exports.adminListUsers = onCall(async (request) => {
  requireDeveloper(request);

  const users = [];
  let pageToken;

  do {
    const result = await auth.listUsers(1000, pageToken);

    for (const user of result.users) {
      const profile = await db.collection("users").doc(user.uid).get();

      users.push({
        uid: user.uid,
        email: user.email || "",
        username: profile.exists
          ? profile.data().username || ""
          : "",
        disabled: user.disabled,
        creationTime: user.metadata.creationTime
      });
    }

    pageToken = result.pageToken;
  } while (pageToken);

  return { users };
});

exports.adminSetUserDisabled = onCall(async (request) => {
  requireDeveloper(request);

  const uid = requireString(request.data?.uid, "user UID");
  const disabled = request.data?.disabled;

  if (typeof disabled !== "boolean") {
    throw new HttpsError(
      "invalid-argument",
      "Disabled must be true or false."
    );
  }

  await auth.updateUser(uid, { disabled });

  if (disabled) {
    await auth.revokeRefreshTokens(uid);
  }

  return { success: true };
});

exports.adminRevokeUserSessions = onCall(async (request) => {
  requireDeveloper(request);

  const uid = requireString(request.data?.uid, "user UID");

  await auth.revokeRefreshTokens(uid);

  return { success: true };
});

// ------------------------------
// DEVELOPER: CONVERSATION MANAGEMENT
// ------------------------------

exports.adminListConversations = onCall(async (request) => {
  requireDeveloper(request);

  const snapshot = await db.collection("conversations").get();

  const conversations = snapshot.docs.map((doc) => {
    const data = doc.data();

    return {
      id: doc.id,
      name: data.name || "",
      isGroup: data.isGroup === true,
      members: data.members || [],
      ownerUid: data.ownerUid || "",
      lastMessage: data.lastMessage || "",
      updatedAt: data.updatedAt || null
    };
  });

  return { conversations };
});

exports.adminGetConversation = onCall(async (request) => {
  requireDeveloper(request);

  const conversationId = requireString(
    request.data?.conversationId,
    "conversation ID"
  );

  const { data } = await getConversation(conversationId);

  const messagesSnapshot = await db
    .collection("conversations")
    .doc(conversationId)
    .collection("messages")
    .orderBy("createdAt", "asc")
    .limit(500)
    .get();

  const messages = messagesSnapshot.docs.map((doc) => ({
    id: doc.id,
    ...doc.data()
  }));

  return {
    conversation: {
      id: conversationId,
      ...data
    },
    messages
  };
});

exports.adminDeleteMessage = onCall(async (request) => {
  requireDeveloper(request);

  const conversationId = requireString(
    request.data?.conversationId,
    "conversation ID"
  );

  const messageId = requireString(
    request.data?.messageId,
    "message ID"
  );

  await db
    .collection("conversations")
    .doc(conversationId)
    .collection("messages")
    .doc(messageId)
    .delete();

  return { success: true };
});

exports.adminDeleteConversation = onCall(async (request) => {
  requireDeveloper(request);

  const conversationId = requireString(
    request.data?.conversationId,
    "conversation ID"
  );

  const ref = db.collection("conversations").doc(conversationId);

  if (!(await ref.get()).exists) {
    throw new HttpsError("not-found", "Conversation not found.");
  }

  await db.recursiveDelete(ref);

  return { success: true };
});

// ------------------------------
// DEVELOPER: RESET APPLICATION DATA
// ------------------------------

exports.adminResetAllData = onCall(async (request) => {
  requireDeveloper(request);

  if (request.data?.confirmation !== "RESET ALL DATA") {
    throw new HttpsError(
      "failed-precondition",
      'You must provide the exact confirmation "RESET ALL DATA".'
    );
  }

  // Delete all conversations and their message subcollections.
  await db.recursiveDelete(db.collection("conversations"));

  // Delete all message requests.
  await db.recursiveDelete(db.collection("messageRequests"));

  // Remove per-user app data while preserving user profiles
  // and Firebase Authentication accounts.
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

  return {
    success: true,
    message: "Application data has been reset. User accounts and profiles were preserved."
  };
});
