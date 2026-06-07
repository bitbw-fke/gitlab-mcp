import express, { Request, Response } from 'express';
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "crypto";
import { getServer } from "./mcpServer.js";
import { InMemoryEventStore } from '@modelcontextprotocol/sdk/examples/shared/inMemoryEventStore.js';
import { hostHeaderValidation } from '@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js';

// Connect the server to a transport and start it
async function runServer() {
    try {
        const app = express();
        app.use(express.json());
        app.use(hostHeaderValidation(['localhost', '127.0.0.1', 'gitlab-mcp']));

        const transports: { [sessionId: string]: StreamableHTTPServerTransport } = {};

        const mcpPostHandler = async (req: Request, res: Response) => {
            const sessionId = req.headers['mcp-session-id'] as string | undefined;

            try {
                let transport: StreamableHTTPServerTransport;
                if (sessionId && transports[sessionId]) {
                    // Reuse existing transport
                    transport = transports[sessionId];
                } else if (!sessionId && isInitializeRequest(req.body)) {
                    // New initialization request
                    const eventStore = new InMemoryEventStore();
                    transport = new StreamableHTTPServerTransport({
                        sessionIdGenerator: () => randomUUID(),
                        eventStore, // Enable resumability
                        onsessioninitialized: sessionId => {
                            // Store the transport by session ID when session is initialized
                            // This avoids race conditions where requests might come in before the session is stored
                            console.log(`Session initialized with ID: ${sessionId}`);
                            transports[sessionId] = transport;
                        }
                    });

                    // Set up onclose handler to clean up transport when closed
                    transport.onclose = () => {
                        const sid = transport.sessionId;
                        if (sid && transports[sid]) {
                            console.log(`Transport closed for session ${sid}, removing from transports map`);
                            delete transports[sid];
                        }
                    };

                    // Connect the transport to the MCP server BEFORE handling the request
                    // so responses can flow back through the same transport
                    const server = getServer();
                    await server.connect(transport);

                    await transport.handleRequest(req, res, req.body);
                    return; // Already handled
                } else {
                    // Invalid request - no session ID or not initialization request
                    res.status(400).json({
                        jsonrpc: '2.0',
                        error: {
                            code: -32000,
                            message: 'Bad Request: No valid session ID provided'
                        },
                        id: null
                    });
                    return;
                }

                // Handle the request with existing transport - no need to reconnect
                // The existing transport is already connected to the server
                await transport.handleRequest(req, res, req.body);
            } catch (error) {
                console.error('Error handling MCP request:', error);
                if (!res.headersSent) {
                    res.status(500).json({
                        jsonrpc: '2.0',
                        error: {
                            code: -32603,
                            message: 'Internal server error'
                        },
                        id: null
                    });
                }
            }
        };

        app.post('/mcp', mcpPostHandler);

        // Handle GET requests for SSE streams (using built-in support from StreamableHTTP)
        const mcpGetHandler = async (req: Request, res: Response) => {
            const sessionId = req.headers['mcp-session-id'] as string | undefined;
            if (!sessionId || !transports[sessionId]) {
                res.status(400).send('Invalid or missing session ID');
                return;
            }

            // Check for Last-Event-ID header for resumability
            const lastEventId = req.headers['last-event-id'] as string | undefined;
            if (lastEventId) {
                console.log(`Client reconnecting with Last-Event-ID: ${lastEventId}`);
            } else {
                console.log(`Establishing new SSE stream for session ${sessionId}`);
            }

            const transport = transports[sessionId];
            await transport.handleRequest(req, res);
        };

        app.get('/mcp', mcpGetHandler);

        // Handle DELETE requests for session termination (according to MCP spec)
        const mcpDeleteHandler = async (req: Request, res: Response) => {
            const sessionId = req.headers['mcp-session-id'] as string | undefined;
            if (!sessionId || !transports[sessionId]) {
                res.status(400).send('Invalid or missing session ID');
                return;
            }

            console.log(`Received session termination request for session ${sessionId}`);

            try {
                const transport = transports[sessionId];
                await transport.handleRequest(req, res);
            } catch (error) {
                console.error('Error handling session termination:', error);
                if (!res.headersSent) {
                    res.status(500).send('Error processing session termination');
                }
            }
        };

        app.delete('/mcp', mcpDeleteHandler);

        const MCP_PORT = process.env.MCP_PORT ? parseInt(process.env.MCP_PORT, 10) : 3000;
        app.listen(MCP_PORT, error => {
            if (error) {
                console.error('Failed to start server:', error);
                process.exit(1);
            }
            console.log(`MCP Streamable HTTP Server listening on port ${MCP_PORT}`);
        });

        // Handle server shutdown
        process.on('SIGINT', async () => {
            console.log('Shutting down server...');

            // Close all active transports to properly clean up resources
            for (const sessionId in transports) {
                try {
                    console.log(`Closing transport for session ${sessionId}`);
                    await transports[sessionId].close();
                    delete transports[sessionId];
                } catch (error) {
                    console.error(`Error closing transport for session ${sessionId}:`, error);
                }
            }
            console.log('Server shutdown complete');
            process.exit(0);
        });
    } catch (error: any) {
        if ("message" in error) {
            console.error("Failed to start server:", error.message);
        } else {
            console.error("Failed to start server due to an unknown error: ", JSON.stringify(error));
        }
        process.exit(1);
    }
}

export { runServer };
