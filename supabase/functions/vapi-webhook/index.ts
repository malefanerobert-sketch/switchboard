// Supabase Edge Function: vapi-webhook (no external imports — uses REST API directly)
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const VAPI_SECRET = Deno.env.get("VAPI_WEBHOOK_SECRET") ?? "";

async function rest(path: string, method: string, body?: unknown) {
  return await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
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
  if (msg.type !== "end-of-call-report") return json({ ignored: msg.type ?? "unknown" });

  const call = msg.call ?? {};
  const analysis = msg.analysis ?? {};
  const sd = analysis.structuredData ?? {};
  const customerNumber = msg.customer?.number ?? call.customer?.number ?? null;
  const calledNumber = msg.phoneNumber?.number ?? null;
  const durationSec = Math.round(msg.durationSeconds ?? (msg.durationMs ? msg.durationMs / 1000 : 0));
  const startedAt = msg.startedAt ?? call.startedAt ?? new Date().toISOString();
  const transcript = msg.artifact?.transcript ?? msg.transcript ?? null;
  const summary = analysis.summary ?? msg.summary ?? null;

  // resolve business
  let businessId: string | null =
    call.assistantOverrides?.metadata?.business_id ?? msg.assistant?.metadata?.business_id ?? null;
  if (!businessId && calledNumber) {
    const r = await rest(`sb_businesses?select=id&phone=eq.${encodeURIComponent(calledNumber)}&limit=1`, "GET");
    const d = await r.json(); businessId = d?.[0]?.id ?? null;
  }
  if (!businessId) {
    const r = await rest(`sb_businesses?select=id&order=created_at.asc&limit=1`, "GET");
    const d = await r.json(); businessId = d?.[0]?.id ?? null;
  }
  if (!businessId) return new Response("no business found", { status: 404 });

  const intent = sd.intent ?? "enquiry";
  const sentiment = sd.sentiment ?? "Neutral";
  const callerName = sd.caller_name ?? sd.name ?? "Unknown caller";
  const structured: Record<string, unknown> = { intent, sentiment };
  if (sd.topic) structured.topic = sd.topic;
  if (sd.booking) structured.booking = sd.booking;
  if (sd.order) structured.order = sd.order;
  const shortId = (call.id ?? crypto.randomUUID()).slice(0, 5);
  const orderRef = sd.order ? "#" + shortId : null;

  const callRes = await rest("sb_calls", "POST", {
    business_id: businessId, vapi_call_id: call.id ?? null, caller_name: callerName,
    caller_phone: customerNumber, started_at: startedAt, duration_sec: durationSec,
    intent, sentiment, summary, transcript, order_ref: orderRef, structured, handled: true,
  });
  if (!callRes.ok) return new Response("call insert failed: " + (await callRes.text()), { status: 500 });

  if (sd.booking) {
    await rest("sb_bookings", "POST", {
      business_id: businessId, caller_name: callerName, service: sd.booking.service ?? "Booking",
      date: sd.booking.date ?? null, time: sd.booking.time ?? null, note: sd.booking.note ?? null, status: "Confirmed",
    });
  }
  if (sd.order) {
    await rest("sb_orders", "POST", {
      business_id: businessId, order_ref: orderRef, caller_name: callerName,
      items: sd.order.items ?? [], total: sd.order.total ?? 0, pickup: sd.order.pickup ?? null, status: "New",
    });
  }
  return json({ ok: true });
});
