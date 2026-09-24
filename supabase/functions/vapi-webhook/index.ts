// Supabase Edge Function: vapi-webhook
// Receives Vapi "end-of-call-report" events and writes them into SwitchBoard tables.
// Deploy:  supabase functions deploy vapi-webhook --no-verify-jwt
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected automatically by Supabase.
// Set your shared secret:  supabase secrets set VAPI_WEBHOOK_SECRET=your-long-random-string

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const VAPI_SECRET = Deno.env.get("VAPI_WEBHOOK_SECRET") ?? "";

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("ok", { status: 200 });

  // Optional shared-secret check (set server.secret in Vapi to the same value)
  if (VAPI_SECRET) {
    const got = req.headers.get("x-vapi-secret") ?? "";
    if (got !== VAPI_SECRET) return new Response("unauthorized", { status: 401 });
  }

  let body: any;
  try { body = await req.json(); } catch { return new Response("bad json", { status: 400 }); }

  const msg = body?.message ?? {};
  if (msg.type !== "end-of-call-report") {
    return json({ ignored: msg.type ?? "unknown" });
  }

  const call = msg.call ?? {};
  const analysis = msg.analysis ?? {};
  const sd = analysis.structuredData ?? {};

  const customerNumber = msg.customer?.number ?? call.customer?.number ?? null;
  const calledNumber = msg.phoneNumber?.number ?? null;
  const durationSec = Math.round(msg.durationSeconds ?? (msg.durationMs ? msg.durationMs / 1000 : 0));
  const startedAt = msg.startedAt ?? call.startedAt ?? new Date().toISOString();
  const transcript = msg.artifact?.transcript ?? msg.transcript ?? null;
  const summary = analysis.summary ?? msg.summary ?? null;

  // Resolve which business this call belongs to:
  // 1) metadata.business_id  2) match called number  3) fall back to first business
  let businessId: string | null =
    call.assistantOverrides?.metadata?.business_id ??
    msg.assistant?.metadata?.business_id ?? null;

  if (!businessId && calledNumber) {
    const { data } = await supabase.from("sb_businesses").select("id").eq("phone", calledNumber).maybeSingle();
    businessId = data?.id ?? null;
  }
  if (!businessId) {
    const { data } = await supabase.from("sb_businesses").select("id").order("created_at").limit(1).maybeSingle();
    businessId = data?.id ?? null;
  }
  if (!businessId) return new Response("no business found", { status: 404 });

  const intent = sd.intent ?? "enquiry";
  const sentiment = sd.sentiment ?? "Neutral";
  const callerName = sd.caller_name ?? sd.name ?? "Unknown caller";

  // structured payload the dashboard reads (mapCall in the frontend)
  const structured: Record<string, unknown> = { intent, sentiment };
  if (sd.topic) structured.topic = sd.topic;
  if (sd.booking) structured.booking = sd.booking;
  if (sd.order) structured.order = sd.order;

  const shortId = (call.id ?? crypto.randomUUID()).slice(0, 5);
  const orderRef = sd.order ? "#" + shortId : null;

  // Insert the call row
  const { error: callErr } = await supabase.from("sb_calls").insert({
    business_id: businessId,
    vapi_call_id: call.id ?? null,
    caller_name: callerName,
    caller_phone: customerNumber,
    started_at: startedAt,
    duration_sec: durationSec,
    intent, sentiment, summary, transcript,
    order_ref: orderRef,
    structured,
    handled: true,
  });
  if (callErr) return new Response("call insert failed: " + callErr.message, { status: 500 });

  // Booking -> sb_bookings
  if (sd.booking) {
    await supabase.from("sb_bookings").insert({
      business_id: businessId,
      caller_name: callerName,
      service: sd.booking.service ?? "Booking",
      date: sd.booking.date ?? null,
      time: sd.booking.time ?? null,
      note: sd.booking.note ?? null,
      status: "Confirmed",
    });
  }

  // Order -> sb_orders
  if (sd.order) {
    await supabase.from("sb_orders").insert({
      business_id: businessId,
      order_ref: orderRef,
      caller_name: callerName,
      items: sd.order.items ?? [],
      total: sd.order.total ?? 0,
      pickup: sd.order.pickup ?? null,
      status: "New",
    });
  }

  return json({ ok: true });
});

function json(obj: unknown) {
  return new Response(JSON.stringify(obj), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
