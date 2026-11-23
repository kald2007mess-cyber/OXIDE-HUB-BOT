import { authorizeAdmin, adminAuthResponse } from "../_lib/admin-auth.js";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}


async function ensureMissionSubmissionsTable(DB) {
  await DB.prepare(`CREATE TABLE IF NOT EXISTS mission_submissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    mission_id INTEGER NOT NULL,
    proof_file_id TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at INTEGER NOT NULL,
    reviewed_at INTEGER
  )`).run();
  const columns = await DB.prepare("PRAGMA table_info(mission_submissions)").all();
  const names = (columns.results || []).map(column => column.name);
  if (!names.includes("user_id")) {
    await DB.prepare("ALTER TABLE mission_submissions ADD COLUMN user_id TEXT").run();
    if (names.includes("user_uuid")) {
      await DB.prepare("UPDATE mission_submissions SET user_id = user_uuid WHERE user_id IS NULL OR user_id = ''").run();
    } else if (names.includes("visitor_id")) {
      await DB.prepare("UPDATE mission_submissions SET user_id = visitor_id WHERE user_id IS NULL OR user_id = ''").run();
    }
  }
  if (!names.includes("proof_file_id")) {
    await DB.prepare("ALTER TABLE mission_submissions ADD COLUMN proof_file_id TEXT").run();
  }
}

async function ensurePointLedger(DB) {
  await DB.prepare(`
    CREATE TABLE IF NOT EXISTS point_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_uuid TEXT NOT NULL,
      delta INTEGER NOT NULL,
      balance_after INTEGER NOT NULL,
      reason TEXT NOT NULL,
      reference_type TEXT NOT NULL,
      reference_id TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `).run();
  await DB.prepare(`
    CREATE INDEX IF NOT EXISTS idx_point_ledger_user
    ON point_ledger(user_uuid, created_at DESC, id DESC)
  `).run();
}

async function ensureRedemptionOrdersTable(DB) {
  await DB.prepare(`
    CREATE TABLE IF NOT EXISTS redemption_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_uuid TEXT NOT NULL,
      public_id TEXT NOT NULL,
      offer_id INTEGER NOT NULL,
      offer_name TEXT NOT NULL,
      points_cost INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL,
      reviewed_at INTEGER,
      telegram_message_id INTEGER,
      refund_token TEXT
    )
  `).run();

  const columns = await DB.prepare("PRAGMA table_info(redemption_orders)").all();
  if (!(columns.results || []).some(column => column.name === "user_uuid_input")) {
    await DB.prepare("ALTER TABLE redemption_orders ADD COLUMN user_uuid_input TEXT").run();
  }
  if (!(columns.results || []).some(column => column.name === "refund_token")) {
    await DB.prepare("ALTER TABLE redemption_orders ADD COLUMN refund_token TEXT").run();
  }
}

async function ensureNotificationsTable(DB) {
  await DB.prepare(`
    CREATE TABLE IF NOT EXISTS oxide_notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      reward_points INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      read_at INTEGER,
      claimed_at INTEGER,
      claim_token TEXT
    )
  `).run();
  await DB.prepare(`
    CREATE INDEX IF NOT EXISTS idx_oxide_notifications_user
    ON oxide_notifications(user_id, created_at DESC)
  `).run();
}

async function notifyUser(DB, userId, type, title, body) {
  await ensureNotificationsTable(DB);
  await DB.prepare(`
    INSERT INTO oxide_notifications(user_id,type,title,body,reward_points,created_at)
    VALUES(?,?,?,?,0,?)
  `).bind(userId, type, title, body, Math.floor(Date.now() / 1000)).run();
}

async function getReviewItems(DB, type) {
  if (type === "missions") {
    const result = await DB.prepare(`
      SELECT s.id, s.user_id, s.mission_id, s.proof_file_id, s.created_at,
             m.title AS mission_title, m.reward_points,
             COALESCE(u.points, v.points, 0) AS points, COALESCE(u.created_at, v.created_at) AS user_created_at,
             CASE WHEN s.proof_file_id IS NOT NULL AND s.proof_file_id != ''
                       AND s.proof_file_id != 'uploading' THEN 1 ELSE 0 END AS proof_available
      FROM mission_submissions s
      JOIN oxide_admin_missions m ON m.id = s.mission_id
      LEFT JOIN users u ON u.user_uuid = s.user_id
      LEFT JOIN visitors v ON v.user_id = s.user_id
      WHERE s.status = 'pending'
      ORDER BY s.created_at ASC, s.id ASC
      LIMIT 50
    `).all();
    return result.results || [];
  }

  if (type === "referrals") {
    const result = await DB.prepare(`
      SELECT r.id, r.referrer_id AS user_id, r.referred_id,
             COALESCE(ru.public_id, 'OX-' || UPPER(SUBSTR(REPLACE(r.referrer_id, '-', ''), 1, 8))) AS display_id,
             COALESCE(ru.points, 0) AS points,
             ru.created_at AS user_created_at,
             COALESCE(du.public_id, 'OX-' || UPPER(SUBSTR(REPLACE(r.referred_id, '-', ''), 1, 8))) AS invited_display_id,
             COALESCE(du.points, 0) AS invited_points,
             r.risk_score, r.risk_reason, r.created_at
      FROM referrals r
      LEFT JOIN users ru ON ru.user_uuid = r.referrer_id
      LEFT JOIN users du ON du.user_uuid = r.referred_id
      WHERE r.status = 'review'
        AND EXISTS (
          SELECT 1 FROM mission_submissions s
          WHERE s.user_id = r.referred_id AND s.status = 'approved'
        )
      ORDER BY r.created_at ASC, r.id ASC
      LIMIT 50
    `).all();
    return result.results || [];
  }

  const result = await DB.prepare(`
    SELECT o.id, o.user_uuid AS user_id, o.public_id AS display_id, o.offer_id, o.offer_name,
           o.points_cost, o.user_uuid_input, o.created_at,
           COALESCE(u.points, v.points, 0) AS points, COALESCE(u.created_at, v.created_at) AS user_created_at,
           (SELECT COUNT(*) FROM mission_submissions s
             WHERE s.user_id = o.user_uuid AND s.status = 'approved') AS completed_missions,
           0 AS invited_friends
    FROM redemption_orders o
    LEFT JOIN users u ON u.user_uuid = o.user_uuid
    LEFT JOIN visitors v ON v.user_id = o.user_uuid
    WHERE o.status = 'pending'
    ORDER BY o.created_at ASC, o.id ASC
    LIMIT 50
  `).all();
  return result.results || [];
}

async function reviewMission(DB, id, decision) {
  const submission = await DB.prepare(`
    SELECT s.id, s.user_id, s.mission_id, s.status, m.title, m.reward_points
    FROM mission_submissions s
    JOIN oxide_admin_missions m ON m.id = s.mission_id
    WHERE s.id = ?
  `).bind(id).first();

  if (!submission || submission.status !== "pending") {
    return { success: false, status: 409, error: "REQUEST_NOT_PENDING" };
  }

  const now = Math.floor(Date.now() / 1000);
  const reward = Math.max(0, Math.floor(Number(submission.reward_points) || 0));

  if (decision === "approve") {
    const results = await DB.batch([
      DB.prepare(`
        UPDATE users SET points = points + ?, updated_at = ?
        WHERE user_uuid = ? AND status = 'active' AND EXISTS (
          SELECT 1 FROM mission_submissions
          WHERE id = ? AND status = 'pending'
        )
      `).bind(reward, now, submission.user_id, id),
      DB.prepare(`
        UPDATE visitors SET points = (
          SELECT points FROM users WHERE user_uuid = visitors.user_id
        )
        WHERE user_id = ? AND changes() = 1
      `).bind(submission.user_id),
      DB.prepare(`
        UPDATE mission_submissions
        SET status = 'approved', reviewed_at = ?
        WHERE id = ? AND status = 'pending'
          AND EXISTS (
            SELECT 1 FROM users
            WHERE user_uuid = ? AND status = 'active'
          )
      `).bind(now, id, submission.user_id),
      DB.prepare(`
        INSERT INTO point_ledger
          (user_uuid,delta,balance_after,reason,reference_type,reference_id,created_at)
        SELECT user_uuid,?,points,'mission_approved','mission_submission',?,?
        FROM users
        WHERE user_uuid = ?
          AND EXISTS (SELECT 1 FROM mission_submissions WHERE id = ? AND status = 'approved')
      `).bind(reward, String(id), now, submission.user_id, id)
    ]);

    if (Number(results[0]?.meta?.changes || 0) !== 1 ||
        Number(results[2]?.meta?.changes || 0) !== 1) {
      return { success: false, status: 409, error: "REQUEST_ALREADY_REVIEWED_OR_USER_MISSING" };
    }

    // Release a referral reward only after the invited account completes
    // a mission approved by an administrator. High-risk referrals remain held.
    try {
      const referral = await DB.prepare(`
        SELECT id, referrer_id FROM referrals
        WHERE referred_id = ? AND status = 'pending'
        LIMIT 1
      `).bind(submission.user_id).first();
      if (referral?.referrer_id) {
        const referralTime = Math.floor(Date.now() / 1000);
        await DB.batch([
          DB.prepare(`
            UPDATE referrals SET status = 'rewarded', points_awarded = 30
            WHERE id = ? AND referred_id = ? AND status = 'pending'
              AND EXISTS (SELECT 1 FROM mission_submissions WHERE id = ? AND status = 'approved')
              AND EXISTS (SELECT 1 FROM users WHERE user_uuid = ? AND status = 'active')
              AND EXISTS (SELECT 1 FROM users WHERE user_uuid = ? AND status = 'active')
          `).bind(referral.id, submission.user_id, id, referral.referrer_id, submission.user_id),
          DB.prepare(`
            UPDATE users SET points = points + 30, updated_at = ?
            WHERE user_uuid = ? AND status = 'active' AND changes() = 1
          `).bind(referralTime, referral.referrer_id),
          DB.prepare(`
            INSERT INTO point_ledger
              (user_uuid,delta,balance_after,reason,reference_type,reference_id,created_at)
            SELECT user_uuid,30,points,'referral_reward','referral',CAST(? AS TEXT),?
            FROM users WHERE user_uuid = ? AND changes() = 1
          `).bind(referral.id,referralTime,referral.referrer_id),
          DB.prepare(`
            UPDATE users SET points = points + 50, updated_at = ?
            WHERE user_uuid = ? AND status = 'active' AND changes() = 1
          `).bind(referralTime, submission.user_id),
          DB.prepare(`
            INSERT INTO point_ledger
              (user_uuid,delta,balance_after,reason,reference_type,reference_id,created_at)
            SELECT user_uuid,50,points,'referral_invited_bonus','referral',CAST(? AS TEXT),?
            FROM users WHERE user_uuid = ? AND changes() = 1
          `).bind(referral.id,referralTime,submission.user_id),
          DB.prepare(`
            UPDATE visitors SET points = (SELECT points FROM users WHERE user_uuid = ?)
            WHERE user_id = ? AND EXISTS (
              SELECT 1 FROM point_ledger WHERE user_uuid = ?
                AND reason = 'referral_reward' AND reference_type = 'referral'
                AND reference_id = CAST(? AS TEXT)
            )
          `).bind(referral.referrer_id,referral.referrer_id,referral.referrer_id,referral.id),
          DB.prepare(`
            UPDATE visitors SET points = (SELECT points FROM users WHERE user_uuid = ?)
            WHERE user_id = ? AND EXISTS (
              SELECT 1 FROM point_ledger WHERE user_uuid = ?
                AND reason = 'referral_invited_bonus' AND reference_type = 'referral'
                AND reference_id = CAST(? AS TEXT)
            )
          `).bind(submission.user_id,submission.user_id,submission.user_id,referral.id)
        ]);
      }
    } catch (referralRewardError) {
      console.error("Deferred referral reward failed:", referralRewardError);
    }

    try {
      await notifyUser(DB, submission.user_id, "mission_approved",
        "✅ تمت الموافقة على مهمتك",
        "تم قبول المهمة " + String(submission.title || "") +
        " وإضافة " + reward.toLocaleString() + " نقطة إلى رصيدك.");
    } catch (error) { console.error("Mission approval notification failed", error); }
    return { success: true, message: "تم قبول المهمة وإضافة " + reward.toLocaleString() + " نقطة للمستخدم." };
  }

  const rejected = await DB.prepare(`
    UPDATE mission_submissions SET status = 'rejected', reviewed_at = ?
    WHERE id = ? AND status = 'pending'
  `).bind(now, id).run();

  if (Number(rejected.meta?.changes || 0) !== 1) {
    return { success: false, status: 409, error: "REQUEST_ALREADY_REVIEWED" };
  }

  try {
    await notifyUser(DB, submission.user_id, "mission_rejected",
      "❌ تم رفض إثبات المهمة",
      "لم يتم قبول إثبات المهمة " + String(submission.title || "") +
      ". راجع المطلوب وأرسل إثباتًا صحيحًا جديدًا.");
  } catch (error) { console.error("Mission rejection notification failed", error); }
  return { success: true, message: "تم رفض المهمة. يمكن للمستخدم إرسال دليل جديد." };
}

async function reviewReferral(DB, id, decision) {
  const referral = await DB.prepare(`
    SELECT id, referrer_id, referred_id, status
    FROM referrals WHERE id = ? LIMIT 1
  `).bind(id).first();
  if (!referral || referral.status !== "review") {
    return { success: false, status: 409, error: "REFERRAL_NOT_PENDING_REVIEW" };
  }

  const now = Math.floor(Date.now() / 1000);
  if (decision === "reject") {
    const rejected = await DB.prepare(`
      UPDATE referrals SET status = 'rejected'
      WHERE id = ? AND status = 'review'
    `).bind(id).run();
    if (Number(rejected.meta?.changes || 0) !== 1) {
      return { success: false, status: 409, error: "REFERRAL_ALREADY_REVIEWED" };
    }
    return { success: true, message: "تم رفض الإحالة المشبوهة دون منح مكافأة." };
  }

  const results = await DB.batch([
    DB.prepare(`
      UPDATE referrals SET status = 'rewarded', points_awarded = 30
      WHERE id = ? AND status = 'review'
        AND EXISTS (SELECT 1 FROM mission_submissions WHERE user_id = ? AND status = 'approved')
        AND EXISTS (SELECT 1 FROM users WHERE user_uuid = ? AND status = 'active')
        AND EXISTS (SELECT 1 FROM users WHERE user_uuid = ? AND status = 'active')
    `).bind(id, referral.referred_id, referral.referrer_id, referral.referred_id),
    DB.prepare(`
      UPDATE users SET points = points + 30, updated_at = ?
      WHERE user_uuid = ? AND status = 'active' AND changes() = 1
    `).bind(now, referral.referrer_id),
    DB.prepare(`
      INSERT INTO point_ledger
        (user_uuid,delta,balance_after,reason,reference_type,reference_id,created_at)
      SELECT user_uuid,30,points,'referral_reward','referral',CAST(? AS TEXT),?
      FROM users WHERE user_uuid = ? AND changes() = 1
    `).bind(id,now,referral.referrer_id),
    DB.prepare(`
      UPDATE users SET points = points + 50, updated_at = ?
      WHERE user_uuid = ? AND status = 'active' AND changes() = 1
    `).bind(now, referral.referred_id),
    DB.prepare(`
      INSERT INTO point_ledger
        (user_uuid,delta,balance_after,reason,reference_type,reference_id,created_at)
      SELECT user_uuid,50,points,'referral_invited_bonus','referral',CAST(? AS TEXT),?
      FROM users WHERE user_uuid = ? AND changes() = 1
    `).bind(id,now,referral.referred_id),
    DB.prepare(`
      UPDATE visitors SET points = (SELECT points FROM users WHERE user_uuid = ?)
      WHERE user_id = ? AND EXISTS (
        SELECT 1 FROM point_ledger WHERE user_uuid = ?
          AND reason = 'referral_reward' AND reference_type = 'referral'
          AND reference_id = CAST(? AS TEXT)
      )
    `).bind(referral.referrer_id,referral.referrer_id,referral.referrer_id,id),
    DB.prepare(`
      UPDATE visitors SET points = (SELECT points FROM users WHERE user_uuid = ?)
      WHERE user_id = ? AND EXISTS (
        SELECT 1 FROM point_ledger WHERE user_uuid = ?
          AND reason = 'referral_invited_bonus' AND reference_type = 'referral'
          AND reference_id = CAST(? AS TEXT)
      )
    `).bind(referral.referred_id,referral.referred_id,referral.referred_id,id)
  ]);

  if (Number(results[0]?.meta?.changes || 0) !== 1 ||
      Number(results[1]?.meta?.changes || 0) !== 1 ||
      Number(results[3]?.meta?.changes || 0) !== 1) {
    return { success: false, status: 409, error: "REFERRAL_REWARD_FAILED" };
  }
  return { success: true, message: "تم اعتماد الإحالة وإضافة 30 لصاحب رابط الدعوة و50 للمستخدم المدعو." };
}

async function reviewRedemption(DB, id, decision) {
  const order = await DB.prepare(`
    SELECT id, user_uuid AS user_id, public_id AS display_id, offer_name, points_cost, status
    FROM redemption_orders WHERE id = ?
  `).bind(id).first();

  if (!order || order.status !== "pending") {
    return { success: false, status: 409, error: "REQUEST_NOT_PENDING" };
  }

  const now = Math.floor(Date.now() / 1000);
  const points = Math.max(0, Math.floor(Number(order.points_cost) || 0));

  if (decision === "approve") {
    const updated = await DB.prepare(`
      UPDATE redemption_orders SET status = 'approved', reviewed_at = ?
      WHERE id = ? AND status = 'pending'
    `).bind(now, id).run();

    if (Number(updated.meta?.changes || 0) !== 1) {
      return { success: false, status: 409, error: "REQUEST_ALREADY_REVIEWED" };
    }

    try {
      await notifyUser(DB, order.user_id, "redemption_approved",
        "✅ تمت الموافقة على طلب الاستبدال",
        "تم قبول طلبك رقم #" + id + " للعرض " +
        String(order.offer_name) + ". تم اعتماد الاستبدال من الإدارة.");
    } catch (error) { console.error("Redemption approval notification failed", error); }
    return { success: true, message: "تمت الموافقة على طلب الاستبدال." };
  }

  const refundToken = crypto.randomUUID();
  const results = await DB.batch([
    DB.prepare(`
      UPDATE redemption_orders
      SET status = 'rejected', reviewed_at = ?, refund_token = ?
      WHERE id = ? AND status = 'pending'
    `).bind(now, refundToken, id),
    DB.prepare(`
      UPDATE users SET points = points + (
        SELECT points_cost FROM redemption_orders
        WHERE id = ? AND refund_token = ?
      ), updated_at = ?
      WHERE user_uuid = (
        SELECT user_uuid FROM redemption_orders
        WHERE id = ? AND refund_token = ?
      )
      AND EXISTS (
        SELECT 1 FROM redemption_orders
        WHERE id = ? AND refund_token = ?
      )
    `).bind(id, refundToken, now, id, refundToken, id, refundToken),
    DB.prepare(`
      UPDATE visitors SET points = (SELECT points FROM users WHERE user_uuid = visitors.user_id)
      WHERE user_id = (SELECT user_uuid FROM redemption_orders WHERE id = ? AND refund_token = ?)
    `).bind(id, refundToken),
    DB.prepare(`
      INSERT INTO point_ledger
        (user_uuid,delta,balance_after,reason,reference_type,reference_id,created_at)
      SELECT users.user_uuid,redemption_orders.points_cost,users.points,
             'redemption_refund','redemption',CAST(redemption_orders.id AS TEXT),?
      FROM users JOIN redemption_orders ON redemption_orders.user_uuid = users.user_uuid
      WHERE redemption_orders.id = ? AND redemption_orders.refund_token = ?
    `).bind(now,id,refundToken)
  ]);

  if (Number(results[0]?.meta?.changes || 0) !== 1 ||
      Number(results[1]?.meta?.changes || 0) !== 1) {
    return { success: false, status: 409, error: "REDEMPTION_REFUND_FAILED" };
  }

  try {
    await notifyUser(DB, order.user_id, "redemption_rejected",
      "❌ تم رفض طلب الاستبدال",
      "تم رفض طلبك رقم #" + id + " للعرض " + String(order.offer_name) +
      " وإعادة " + points.toLocaleString() + " نقطة إلى رصيدك.");
  } catch (error) { console.error("Redemption rejection notification failed", error); }
  return { success: true, message: "تم رفض الطلب وإعادة " + points.toLocaleString() + " نقطة للمستخدم." };
}

async function getProofResponse(env, initData, submissionId) {
  const auth = await authorizeAdmin(initData, env, "tasks");
  if (!auth.ok) return adminAuthResponse(auth);

  const row = await env.DB.prepare(`
    SELECT proof_file_id FROM mission_submissions
    WHERE id = ? AND status = 'pending'
  `).bind(submissionId).first();

  if (!row?.proof_file_id || row.proof_file_id === "uploading") {
    return json({ success: false, error: "PROOF_NOT_FOUND" }, 404);
  }

  const infoResponse = await fetch(
    "https://api.telegram.org/bot" + env.TELEGRAM_BOT_TOKEN +
    "/getFile?file_id=" + encodeURIComponent(row.proof_file_id)
  );
  const info = await infoResponse.json();
  const filePath = info?.result?.file_path;
  if (!infoResponse.ok || !info.ok || !filePath) {
    return json({ success: false, error: "TELEGRAM_FILE_LOOKUP_FAILED" }, 502);
  }

  const fileResponse = await fetch(
    "https://api.telegram.org/file/bot" + env.TELEGRAM_BOT_TOKEN + "/" + filePath
  );
  if (!fileResponse.ok) return json({ success: false, error: "PROOF_DOWNLOAD_FAILED" }, 502);

  return new Response(fileResponse.body, {
    status: 200,
    headers: {
      "Content-Type": fileResponse.headers.get("Content-Type") || "image/jpeg",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
    }
  });
}

export async function onRequestPost({ request, env }) {
  try {
    if (!env.DB || !env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_ADMIN_ID) {
      return json({ success: false, error: "SERVER_CONFIGURATION_MISSING" }, 500);
    }

    const body = await request.json();
    const action = String(body.action || "");

    if (action === "proof") {
      const submissionId = Number(body.submissionId);
      if (!Number.isSafeInteger(submissionId) || submissionId < 1) {
        return json({ success: false, error: "INVALID_REQUEST_ID" }, 400);
      }
      return await getProofResponse(env, String(body.initData || ""), submissionId);
    }

    const auth = await authorizeAdmin(String(body.initData || ""), env, "tasks");
    if (!auth.ok) return adminAuthResponse(auth);
    await ensureMissionSubmissionsTable(env.DB);
    await ensurePointLedger(env.DB);

    if (action === "list") {
      const type = String(body.type || "");
      if (!["missions", "redemptions", "referrals"].includes(type)) {
        return json({ success: false, error: "INVALID_REVIEW_TYPE" }, 400);
      }
      if (type === "redemptions") await ensureRedemptionOrdersTable(env.DB);
      const items = await getReviewItems(env.DB, type);
      return json({ success: true, items, more: items.length === 50 });
    }

    if (action === "review") {
      const type = String(body.type || "");
      const id = Number(body.id);
      const decision = String(body.decision || "");
      if (!["missions", "redemptions", "referrals"].includes(type) ||
          !Number.isSafeInteger(id) || id < 1 ||
          !["approve", "reject"].includes(decision)) {
        return json({ success: false, error: "INVALID_REVIEW_ACTION" }, 400);
      }
      if (type === "redemptions") await ensureRedemptionOrdersTable(env.DB);
      const result = type === "missions"
        ? await reviewMission(env.DB, id, decision)
        : type === "referrals"
          ? await reviewReferral(env.DB, id, decision)
          : await reviewRedemption(env.DB, id, decision);
      return json(result, result.status || (result.success ? 200 : 400));
    }

    return json({ success: false, error: "INVALID_ACTION" }, 400);
  } catch (error) {
    return json({
      success: false,
      error: "ADMIN_REVIEWS_ERROR",
      details: String(error?.message || error)
    }, 500);
  }
}
