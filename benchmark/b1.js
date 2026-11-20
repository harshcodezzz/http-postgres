import http from "k6/http";
import { check } from "k6";

const mode = __ENV.B1_MODE || "closed-loop";
if (mode !== "closed-loop" && mode !== "arrival") {
  throw new Error("Set B1_MODE to closed-loop or arrival.");
}

const virtualUsers = Number(__ENV.B1_VUS || 8);
if (mode === "closed-loop" && (!Number.isSafeInteger(virtualUsers) || virtualUsers < 1)) {
  throw new Error("Set B1_VUS to a positive integer.");
}

export const options = {
  scenarios: {
    benchmark: mode === "arrival" ? {
      executor: "ramping-arrival-rate",
      startRate: 100,
      timeUnit: "1s",
      preAllocatedVUs: 200,
      maxVUs: 2000,
      stages: [
        { target: 1000, duration: "30s" },
        { target: 2500, duration: "30s" },
        { target: 5000, duration: "30s" },
        { target: 10000, duration: "30s" },
        { target: 10000, duration: "60s" },
        { target: 0, duration: "10s" },
      ],
    } : {
      executor: "constant-vus",
      vus: virtualUsers,
      duration: "60s",
    },
  },
  thresholds: {
    "http_req_failed{phase:workload}": ["rate<0.01"],
    "http_req_duration{phase:workload}": ["p(95)<100"],
    ...(mode === "arrival" && { dropped_iterations: ["count==0"] }),
    checks: ["rate>0.99"],
  },
};

const apiKey = __ENV.API_KEY?.trim();
if (!apiKey || !/^KEY_(?:LIVE|TEST)_[A-Za-z0-9_-]{16,}$/.test(apiKey)) {
  throw new Error("Set API_KEY to the raw gateway API key before running b1.");
}

const baseUrl = (__ENV.BASE_URL || "http://127.0.0.1:8080").replace(/\/+$/, "");
const headers = {
  "Content-Type": "application/json",
  "X-API-Key": apiKey,
  "X-Database": __ENV.DB_NAME || "postgres",
};

function query(sql, parameters, phase) {
  return http.post(`${baseUrl}/query`, JSON.stringify({ query: sql, parameters }), { headers, tags: { phase } });
}

function preflight(sql) {
  const response = query(sql, [], "setup");
  let body;
  try {
    body = response.json();
  } catch {
    // A failed connection or non-gateway response may have no JSON body.
  }
  if (response.status !== 200 || body?.success !== true || !Array.isArray(body.rows)) {
    const reason = body?.error?.code || response.error || "invalid gateway response";
    throw new Error(`Benchmark setup failed (HTTP ${response.status}): ${reason}`);
  }
  return body.rows;
}

export function setup() {
  const [fixture] = preflight(`
    SELECT count(*) AS row_count, min(id) AS first_id, max(id) AS last_id
    FROM (SELECT id FROM public.benchmark ORDER BY id LIMIT 100000) AS benchmark_rows
  `);
  const rowCount = Number(fixture?.row_count);
  if (!Number.isInteger(rowCount)) throw new Error("The gateway returned an invalid benchmark row count.");
  if (rowCount === 0) {
    throw new Error("public.benchmark is empty. Load benchmark rows before starting b1.");
  }
  if (rowCount === fixture.last_id - fixture.first_id + 1) {
    return { firstId: fixture.first_id, rowCount };
  }

  // Keep setup data small because k6 copies it into each virtual user.
  const rows = preflight("SELECT id FROM public.benchmark ORDER BY id LIMIT 1000");
  if (rows.length === 0) throw new Error("public.benchmark became empty during setup.");
  return { ids: rows.map(({ id }) => id), rowCount: rows.length };
}

export default function ({ firstId, ids, rowCount }) {
  const index = Math.floor(Math.random() * rowCount);
  const id = ids ? ids[index] : firstId + index;
  const sql = Math.random() < 0.8
    ? "SELECT id, value FROM public.benchmark WHERE id = $1"
    : "UPDATE public.benchmark SET value = value + 1 WHERE id = $1";

  check(query(sql, [id], "workload"), {
    "query succeeded and matched one row": (response) => {
      if (response.status !== 200) return false;
      try {
        const body = response.json();
        return body.success === true && body.rowCount === 1;
      } catch {
        return false;
      }
    },
  });
}
