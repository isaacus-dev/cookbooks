const pair = (reference, input) => new URLSearchParams({ reference, input });
const postJson = (body) => ({
  method: "POST",
  headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
  body: JSON.stringify(body),
});

async function request(url, what, init, missing = false) {
  const response = await fetch(url, init);
  if (missing && response.status === 404) return null;
  if (response.ok) return response;
  const text = await response.text();
  let message = `${what} (${response.status})`;
  try {
    message = JSON.parse(text)?.error || message;
  } catch {
    message = text || message;
  }
  throw new Error(message);
}

const json = async (url, what, missing) => (await request(url, what, undefined, missing))?.json() ?? null;

export const getCatalog = () => json("/api/catalog", "Could not load documents");
export const getRun = (reference, input) => json(`/api/run?${pair(reference, input)}`, "Could not load run", true);
export const getReviews = (reference, input) => json(`/api/reviews?${pair(reference, input)}`, "Could not load recommendations", true);
export const getAnalysisStatus = () => json("/api/analysis/status", "Could not load analysis status");

export async function uploadDocuments({ referenceFile, inputFile }) {
  const body = new FormData();
  if (referenceFile) body.append("reference_file", referenceFile);
  if (inputFile) body.append("input_file", inputFile);
  return (await request("/api/uploads", "Upload failed", { method: "POST", body })).json();
}

export async function pollAnalysisUntilDone(onEvent) {
  let announced = false;
  let lastMessage = null;
  let lastProgress = null;
  for (;;) {
    const status = await getAnalysisStatus();
    if (!announced && status.input) {
      announced = true;
      onEvent({ type: "started", reference: status.reference, input: status.input });
    }
    if (status.message && status.message !== lastMessage) {
      lastMessage = status.message;
      onEvent({ type: "status", message: status.message });
    }
    const { progress } = status;
    if (progress?.total && `${progress.done}/${progress.total}` !== lastProgress) {
      lastProgress = `${progress.done}/${progress.total}`;
      onEvent({ type: "progress", document: progress.document ?? status.input, done: progress.done, total: progress.total });
    }
    if (status.state !== "running") return status;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

function read(reader) {
  let timer;
  const silence = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("Analysis stream went silent")), 45000);
  });
  return Promise.race([reader.read(), silence]).finally(() => clearTimeout(timer));
}

async function readEvents(response, what, onEvent, isDone) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await read(reader).catch(async (error) => {
      await reader.cancel().catch(() => {});
      throw error;
    });
    if (done) return null;
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split("\n\n");
    buffer = chunks.pop();
    for (const chunk of chunks) {
      const line = chunk.split("\n").find((entry) => entry.startsWith("data: "));
      if (!line) continue;
      const event = JSON.parse(line.slice(6));
      onEvent?.(event);
      if (event.type === "error") throw Object.assign(new Error(event.message || what), { reported: true });
      const result = isDone(event);
      if (!result) continue;
      void (async () => {
        try {
          while (!(await read(reader)).done);
        } catch {
          await reader.cancel().catch(() => {});
        }
      })();
      return result;
    }
  }
}

export async function startAnalysis(options, onEvent) {
  const response = await request("/api/analyze/stream", "Analysis failed", postJson(options));
  let runId = null;
  try {
    runId = await readEvents(response, "Analysis failed", onEvent, (event) => (event.type === "ready" || event.type === "complete") && event.run?.id);
  } catch (error) {
    if (error.reported) throw error;
    console.warn("Analysis stream dropped; falling back to status polling", error);
  }
  if (!runId) {
    const status = await pollAnalysisUntilDone(onEvent);
    if (status.state === "error") throw new Error(status.error || "Analysis failed");
    runId = status.run_id;
  }
  if (!runId) throw new Error("Analysis finished without a result");
  return runId;
}

export async function startReviews(options, onEvent) {
  const response = await request("/api/reviews/stream", "Recommendations failed", postJson(options));
  await readEvents(response, "Recommendations failed", onEvent, (event) => event.type === "complete");
}
