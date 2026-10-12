// Fake MCP server for tests: newline-delimited JSON-RPC 2.0 over stdio.
// Speaks just enough of the protocol for Daedalus's McpClient: initialize,
// tools/list, tools/call with `echo`, `add`, and `fail` tools.
import { createInterface } from 'node:readline';

const tools = [
  {
    name: 'echo',
    description: 'Echo back the provided text.',
    inputSchema: { type: 'object', required: ['text'], properties: { text: { type: 'string' } }, additionalProperties: false },
  },
  {
    name: 'add',
    description: 'Add two numbers.',
    inputSchema: { type: 'object', required: ['a', 'b'], properties: { a: { type: 'number' }, b: { type: 'number' } }, additionalProperties: false },
  },
  {
    name: 'fail',
    description: 'Always returns an error result.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    return;
  }
  if (message.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'fake-mcp', version: '1.0.0' },
      },
    });
    return;
  }
  if (message.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: message.id, result: { tools } });
    return;
  }
  if (message.method === 'tools/call') {
    const { name, arguments: args = {} } = message.params ?? {};
    if (name === 'echo') {
      send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: String(args.text ?? '') }], isError: false } });
    } else if (name === 'add') {
      send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: String((args.a ?? 0) + (args.b ?? 0)) }], isError: false } });
    } else if (name === 'fail') {
      send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'fake tool failure' }], isError: true } });
    } else if (message.id !== undefined) {
      send({ jsonrpc: '2.0', id: message.id, error: { code: -32602, message: `unknown tool ${name}` } });
    }
    return;
  }
  if (message.id !== undefined) {
    send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `method not found: ${message.method}` } });
  }
});
