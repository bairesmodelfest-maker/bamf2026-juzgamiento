// ─────────────────────────────────────────────────────────────────────────
// Cloudflare Pages Function — Juzgamiento BAIRES MODELFEST 2026
//
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

// ─────────────────────────────────────────────────────────────────────────
// ENDURECIDO: este proxy ya NO reenvía cualquier "path"/"op"/campo que
// mande el cliente. Solo permite exactamente lo que la app de Juzgamiento
// necesita: buscar en Inscripción, buscar/crear un juzgamiento, y borrar
// (para el flujo de edición) — siempre y solo sobre el form de
// Juzgamiento. Así, aunque alguien descubra la URL pública y le pegue
// directo a /api/jf con curl, no puede leer ni tocar Inscripción,
// Votopúblico ni ningún otro form/campo que use esta misma API Key.
// ─────────────────────────────────────────────────────────────────────────
const FORM_INSCRIPCION = "240386129030651";
const FORM_JUZGAMIENTO = "241387353267664";

// Únicos campos que este proxy puede escribir en una submission de
// Juzgamiento (copiados de QID_JUZG en index.html).
const CAMPOS_JUZGAMIENTO_PERMITIDOS = new Set([
  "488", "384", "361", "362", "363", "364", "365", "366", "367", "368",
  "419", "369", "420", "585", "579", "475", "471", "463", "464", "467",
  "469", "482", "483", "484", "522",
]);

function campoPermitido(key) {
  // Formatos válidos: submission[123] | submission[123][] | submission[123][4]
  const m = /^submission\[(\d+)\](\[\d*\])?$/.exec(key);
  return !!m && CAMPOS_JUZGAMIENTO_PERMITIDOS.has(m[1]);
}

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

  // Rutas válidas para este proxy:
  //  - GET  /form/<INSCRIPCION>/submissions  (buscar modelo por orden)
  //  - GET  /form/<JUZGAMIENTO>/submissions  (ver si ya fue juzgado)
  //  - POST /form/<JUZGAMIENTO>/submissions  (cargar/editar un juzgamiento)
  //  - DELETE /submission/<ID>               (borrar juzgamiento previo al editar)
  const isGetInscripcion = op === "get" && path === `/form/${FORM_INSCRIPCION}/submissions`;
  const isGetJuzgamiento = op === "get" && path === `/form/${FORM_JUZGAMIENTO}/submissions`;
  const isPostJuzgamiento = op === "post" && path === `/form/${FORM_JUZGAMIENTO}/submissions`;
  const isDeleteSubmission = op === "delete" && /^\/submission\/[a-zA-Z0-9]+$/.test(path);

  if (!isGetInscripcion && !isGetJuzgamiento && !isPostJuzgamiento && !isDeleteSubmission) {
    return json({ ok: false, error: "Ruta no permitida para este proxy" }, 403, cors);
  }

  // Si es una carga de juzgamiento, cada campo enviado tiene que ser uno
  // de los campos reales del form de Juzgamiento — nada más.
  if (isPostJuzgamiento && Array.isArray(formFields)) {
    const todosPermitidos = formFields.every(function (pair) {
      return campoPermitido(pair[0]);
    });
    if (!todosPermitidos) {
      return json({ ok: false, error: "Campo no permitido para este proxy" }, 403, cors);
    }
  }

  // Antes de borrar una submission, confirmamos contra JotForm que
  // pertenece al form de Juzgamiento — así un DELETE nunca puede afectar
  // una inscripción (u otro form) aunque alguien adivine/pruebe un ID.
  if (isDeleteSubmission) {
    const submissionID = path.split("/").pop();
    try {
      const checkUrl = new URL(`${JOTFORM_BASE}/submission/${submissionID}`);
      checkUrl.searchParams.set("apiKey", env.JOTFORM_API_KEY);
      const checkRes = await fetch(checkUrl.toString());
      const checkJson = await checkRes.json();
      const formId = checkJson && checkJson.content && checkJson.content.form_id;
      if (String(formId) !== FORM_JUZGAMIENTO) {
        return json({ ok: false, error: "No se puede borrar esa submission desde este proxy" }, 403, cors);
      }
    } catch (err) {
      return json({ ok: false, error: "No se pudo verificar la submission a borrar" }, 502, cors);
    }
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
