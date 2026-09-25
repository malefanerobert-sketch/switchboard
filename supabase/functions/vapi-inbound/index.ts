// Supabase Edge Function: vapi-inbound
// Handles Vapi's inbound "assistant-request" webhook. On each incoming call it
// resolves which business was called, checks that business's master switch
// (sb_businesses.vapi_enabled) and either:
//   - ON  -> answers with the business's voice agent (assistant), tagging the
//            call with metadata.business_id so the end-of-call report is logged
//            to the correct business automatically.
//   - OFF -> transfers the caller to that business's fallback_phone (or, if none
//            is set, ends the call with a polite message).
// No external imports — talks to Supabase via the REST API directly.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const VAPI_SECRET = Deno.env.get("VAPI_WEBHOOK_SECRET") ?? "";
// Optional workspace-wide default assistant, used when a business row has no
// vapi_assistant_id of its own (handy for single-assistant / test setups).
const DEFAULT_ASSISTANT_ID = Deno.env.get("VAPI_ASSISTANT_ID") ?? "";

async function rest(path: string, method: string, body?: unknown) {
  return await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("ok", { status: 200 });
  if (VAPI_SECRET) {
    const got = req.headers.get("x-vapi-secret") ?? "";
    if (got !== VAPI_SECRET) return new Response("unauthorized", { status: 401 });
  }

  let body: any;
  try { body = await req.json(); } catch { return new Response("bad json", { status: 400 }); }

  const msg = body?.message ?? {};
  // Only inbound assistant requests are handled here. End-of-call reports are
  // handled by the separate vapi-webhook function.
  if (msg.type !== "assistant-request") return json({ ignored: msg.type ?? "unknown" });

  const calledNumber = msg.phoneNumber?.number ?? msg.call?.phoneNumber?.number ?? null;
  const metaBiz =
    msg.call?.assistantOverrides?.metadata?.business_id ?? msg.assistant?.metadata?.business_id ?? null;

  // Resolve the business: metadata override -> matching Vapi number / phone ->
  // single-business fallback (only when exactly one business exists).
  let biz: any = null;
  if (metaBiz) {
    const r = await rest(`sb_businesses?select=*&id=eq.${encodeURIComponent(metaBiz)}&limit=1`, "GET");
    biz = (await r.json())?.[0] ?? null;
  }
  if (!biz && calledNumber) {
    const enc = encodeURIComponent(calledNumber);
    const r = await rest(`sb_businesses?select=*&or=(vapi_number.eq.${enc},phone.eq.${enc})&limit=1`, "GET");
    biz = (await r.json())?.[0] ?? null;
  }
  if (!biz) {
    const r = await rest(`sb_businesses?select=*&order=created_at.asc&limit=2`, "GET");
    const d = await r.json();
    if (Array.isArray(d) && d.length === 1) biz = d[0];
  }

  // Unknown business: don't drop the call if we have a default assistant.
  if (!biz) {
    if (DEFAULT_ASSISTANT_ID) return json({ assistantId: DEFAULT_ASSISTANT_ID });
    return json({ error: "Sorry, this number is not configured. Please try again later." });
  }

  const enabled = biz.vapi_enabled !== false;

  if (enabled) {
    const assistantId = biz.vapi_assistant_id || DEFAULT_ASSISTANT_ID;
    if (!assistantId) {
      return json({ error: "This line is temporarily unavailable. Please try again shortly." });
    }
    return json({
      assistantId,
      assistantOverrides: { metadata: { business_id: biz.id } },
    });
  }

  // Switch OFF -> forward to the client's fallback number if set.
  if (biz.fallback_phone) {
    return json({
      destination: {
        type: "number",
        number: biz.fallback_phone,
        message: "One moment, connecting your call now.",
      },
    });
  }

  // OFF with no fallback -> end politely.
  return json({ error: "Thanks for calling. Our team is currently unavailable. Please try again later." });
});
