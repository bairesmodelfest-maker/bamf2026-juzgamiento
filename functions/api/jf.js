
// Este archivo va en  functions/api/jf.js  del proyecto de Cloudflare Pages
// (bamf2026-juzgamiento). Es el ÚNICO lugar donde vive la API Key de
// JotForm — nunca viaja al celular del jurado, así la página puede ser
// pública sin que nadie pueda copiarla desde el código fuente.
//
// La app le pega a "/api/jf" (ruta relativa, mismo dominio) con:
//   { op: "get" | "post" | "delete", path: "...", params: {...}, formFields: [[k,v], ...] }
// y este proxy arma la llamada real a api.jotform.com agregando la key.
//
// CONFIGURACIÓN NECESARIA EN CLOUDFLARE:
//   Pages → bamf2026-juzgamiento → Settings → Environment variables
//   → Add variable → nombre: JOTFORM_API_KEY, valor: (la misma key que
//   ya usaban antes en el HTML) → Type: Secret → guardar → re-deploy.
// ─────────────────────────────────────────────────────────────────────────

const JOTFORM_BASE = "https://api.jotform.com";

export async function onRequestPost({ request, env }) {
  const cors = { "Access-Control-Allow-Origin": "*" };

  if (!env.JOTFORM_API_KEY) {
    return json({ ok: false, error: "Falta configurar la variable JOTFORM_API_KEY en Cloudflare Pages" }, 500, cors);
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ ok: false, error: "Body inválido" }, 400, cors);
  }

  const op = body.op;
  const path = body.path;
  const params = body.params || {};
  const formFields = body.formFields || null;

  if (!op || !path || typeof path !== "string" || !path.startsWith("/")) {
    return json({ ok: false, error: "Parámetros inválidos" }, 400, cors);
  }
  if (op !== "get" && op !== "post" && op !== "delete") {
    return json({ ok: false, error: "Operación no soportada" }, 400, cors);
  }

  const url = new URL(JOTFORM_BASE + path);
  url.searchParams.set("apiKey", env.JOTFORM_API_KEY);
  for (const k in params) {
    if (params[k] !== undefined && params[k] !== null) {
      url.searchParams.set(k, String(params[k]));
    }
  }

  const fetchOpts = {
    method: op === "delete" ? "DELETE" : op === "post" ? "POST" : "GET",
  };

  if (op === "post") {
    const usp = new URLSearchParams();
    if (Array.isArray(formFields)) {
      formFields.forEach(function (pair) {
        usp.append(pair[0], pair[1]);
      });
    }
    fetchOpts.body = usp.toString();
    fetchOpts.headers = { "Content-Type": "application/x-www-form-urlencoded" };
  }

  try {
    const jfRes = await fetch(url.toString(), fetchOpts);
    const jfJson = await jfRes.json();
    return json({ ok: true, data: jfJson }, 200, cors);
  } catch (err) {
    return json({ ok: false, error: err.message || "Error al comunicarse con JotForm" }, 502, cors);
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
}

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...cors },
  });
}
