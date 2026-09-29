// Shared mock OpenAI-compatible /v1/embeddings server for tests.
// Binds to a random loopback port; no auth by default.
import { createServer, type Server } from 'node:http';

export interface MockState {
  server: Server;
  url: string;
  requests: { input: string[]; auth: string | null }[];
  close: () => Promise<void>;
}

/** Start a mock embeddings server. `vectorFor` decides the vector per input text. */
export function startMockEmbeddings(vectorFor: (text: string) => number[]): Promise<MockState> {
  const requests: { input: string[]; auth: string | null }[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const parsed = JSON.parse(body) as { input: string[] };
      requests.push({ input: parsed.input, auth: req.headers.authorization ?? null });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ data: parsed.input.map((t, i) => ({ embedding: vectorFor(t), index: i })) }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      resolve({
        server,
        url: `http://127.0.0.1:${port}/v1/embeddings`,
        requests,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}
