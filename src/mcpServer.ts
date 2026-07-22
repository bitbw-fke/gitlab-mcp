import { Gitlab } from "@gitbeaker/rest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import z from "zod";

// Initialize GitLab API Client
const gitlabToken = process.env.MR_MCP_GITLAB_TOKEN;
if (!gitlabToken) {
    throw new Error("Error: MR_MCP_GITLAB_TOKEN environment variable is not set.");
}

const api = new Gitlab({
    host: process.env.MR_MCP_GITLAB_HOST,
    token: gitlabToken,
});

// Helper function to format errors for MCP responses
const formatErrorResponse = (error: any | unknown): CallToolResult => ({
    content: [{ type: "text", text: `Error: ${error.message} - ${error.cause?.description || "No additional details"}` }],
    isError: true,
});

const getServer = () => {
    // Initialize the MCP server
    const server = new McpServer(
        {
            name: "GitlabMCP",
            version: "1.0.0",
        }
    );

    // --- Merge Request Tools ---
    server.registerTool(
        "get_projects", {
        description:
            "Get a list of projects with id, name, description, web_url and other useful information.",
        inputSchema: z.object({
            search: z.string().optional().describe("Search term to filter projects by name or description"),
            verbose: z.boolean().default(false).describe("By default a filtered version is returned, suitable for most cases. Only set true if more information is needed."),
        })
    },
        async ({ search, verbose }) => {
            try {
                const projectFilter = {
                    ...(process.env.MR_MCP_MIN_ACCESS_LEVEL ? { minAccessLevel: parseInt(process.env.MR_MCP_MIN_ACCESS_LEVEL, 10) } : {}),
                    ...(process.env.MR_MCP_PROJECT_SEARCH_TERM ? { search: process.env.MR_MCP_PROJECT_SEARCH_TERM } : {}),
                }
                const projects = await api.Projects.all({ search, membership: true, ...projectFilter });
                const filteredProjects = verbose ? projects : projects.map(project => ({
                    id: project.id,
                    description: project.description,
                    name: project.name,
                    path: project.path,
                    path_with_namespace: project.path_with_namespace,
                    web_url: project.web_url,
                    default_branch: project.default_branch,
                }));

                const projectsText = Array.isArray(filteredProjects) && filteredProjects.length > 0
                    ? JSON.stringify(filteredProjects, null, 2)
                    : "No projects found.";
                return {
                    content: [{ type: "text", text: projectsText }],
                };
            } catch (error) {
                return formatErrorResponse(error);
            }
        }
    );

    server.registerTool(
        "list_open_merge_requests",
        {
            description: "Lists all open merge requests in the project",
            inputSchema: z.object({
                project_id: z.number().describe("The project ID of the merge request"),
                verbose: z.boolean().default(false).describe("By default a filtered version is returned, suitable for most cases. Only set true if more information is needed."),
            })
        },
        async ({ verbose, project_id }) => {
            try {
                const mergeRequests = await api.MergeRequests.all({ projectId: project_id, state: 'opened' });

                const filteredMergeRequests = verbose ? mergeRequests : mergeRequests.map(mr => ({
                    iid: mr.iid,
                    project_id: mr.project_id,
                    title: mr.title,
                    description: mr.description,
                    state: mr.state,
                    web_url: mr.web_url,
                }));
                return {
                    content: [{ type: 'text', text: JSON.stringify(filteredMergeRequests, null, 2) }],
                };
            } catch (error) {
                return formatErrorResponse(error);
            }
        }
    );

    server.registerTool(
        "get_merge_request_details",
        {
            description: "Get details about a specific merge request of a project like title, source-branch, target-branch, web_url, ...",
            inputSchema: z.object({
                project_id: z.number().describe("The project ID of the merge request"),
                merge_request_iid: z.number().describe("The internal ID of the merge request within the project"),
                verbose: z.boolean().default(false).describe("By default a filtered version is returned, suitable for most cases. Only set true if more information is needed."),
            })
        },
        async ({ project_id, merge_request_iid, verbose }) => {
            try {
                const mr = await api.MergeRequests.show(project_id, merge_request_iid);
                const filteredMr = verbose ? mr : {
                    title: mr.title,
                    description: mr.description,
                    state: mr.state,
                    web_url: mr.web_url,
                    target_branch: mr.target_branch,
                    source_branch: mr.source_branch,
                    merge_status: mr.merge_status,
                    detailed_merge_status: mr.detailed_merge_status,
                    diff_refs: mr.diff_refs,
                };
                return {
                    content: [{ type: "text", text: JSON.stringify(filteredMr, null, 2) }],
                };
            } catch (error) {
                return formatErrorResponse(error);
            }
        }
    );

    server.registerTool(
        "get_merge_request_comments",
        {
            description: "Get general and file diff comments of a certain merge request",
            inputSchema: z.object({
                project_id: z.number().describe("The project ID of the merge request"),
                merge_request_iid: z.number().describe("The internal ID of the merge request within the project"),
                verbose: z.boolean().default(false).describe("By default a filtered version is returned, suitable for most cases. Only set true if more information is needed."),
            })
        },
        async ({ project_id, merge_request_iid, verbose }) => {
            try {
                const discussions = await api.MergeRequestDiscussions.all(project_id, merge_request_iid);

                if (verbose) {
                    return {
                        content: [{ type: "text", text: JSON.stringify(discussions, null, 2) }],
                    };
                }

                const unresolvedNotes = discussions.flatMap(note => note.notes).filter(note => note !== undefined).filter(note => note.resolved === false);
                const disscussionNotes = unresolvedNotes.filter(note => note.type === "DiscussionNote").map(note => ({
                    id: note.id,
                    noteable_id: note.noteable_id,
                    body: note.body,
                    author_name: note.author.name,
                }));
                const diffNotes = unresolvedNotes.filter(note => note.type === "DiffNote").map(note => ({
                    id: note.id,
                    noteable_id: note.noteable_id,
                    body: note.body,
                    author_name: note.author.name,
                    position: note.position,
                }));
                return {
                    content: [{
                        type: "text", text: JSON.stringify({
                            disscussionNotes,
                            diffNotes
                        }, null, 2)
                    }],
                };
            } catch (error) {
                return formatErrorResponse(error);
            }
        }
    );

    server.registerTool(
        "add_merge_request_comment",
        {
            description: "Add a general comment to a merge request",
            inputSchema: z.object({
                project_id: z.number().describe("The project ID of the merge request"),
                merge_request_iid: z.number().describe("The internal ID of the merge request within the project"),
                comment: z.string().describe("The comment text"),
            })
        },
        async ({ project_id, merge_request_iid, comment }) => {
            try {
                const note = await api.MergeRequestNotes.create(project_id, merge_request_iid, comment);
                return {
                    content: [{ type: "text", text: JSON.stringify(note, null, 2) }],
                };
            } catch (error) {
                return formatErrorResponse(error);
            }
        }
    );

    server.registerTool(
        "add_merge_request_diff_comment",
        {
            description: "Add a comment of a merge request at a specific line in a file diff",
            inputSchema: z.object({
                project_id: z.number().describe("The project ID of the merge request"),
                merge_request_iid: z.number().describe("The internal ID of the merge request within the project"),
                comment: z.string().describe("The comment text"),
                base_sha: z.string().describe("The SHA of the base commit"),
                start_sha: z.string().describe("The SHA of the start commit"),
                head_sha: z.string().describe("The SHA of the head commit"),
                file_path: z.string().describe("The path to the file being commented on"),
                line_number: z.string().describe("The line number in the new version of the file"),
            })
        },
        async ({ project_id, merge_request_iid, comment, base_sha, start_sha, head_sha, file_path, line_number }) => {
            try {
                const discussion = await api.MergeRequestDiscussions.create(
                    project_id,
                    merge_request_iid,
                    comment,
                    {
                        position: {
                            baseSha: base_sha,
                            startSha: start_sha,
                            headSha: head_sha,
                            oldPath: file_path,
                            newPath: file_path,
                            positionType: 'text',
                            newLine: line_number,
                        },
                    }
                );
                return {
                    content: [{ type: "text", text: JSON.stringify(discussion, null, 2) }],
                };
            } catch (error) {
                return formatErrorResponse(error);
            }
        }
    );

    server.registerTool(
        "get_merge_request_diff",
        {
            description: "Get the file diffs of a certain merge request",
            inputSchema: z.object({
                project_id: z.number().describe("The project ID of the merge request"),
                merge_request_iid: z.number().describe("The internal ID of the merge request within the project"),
            })
        },
        async ({ project_id, merge_request_iid }) => {
            try {
                const diff = await api.MergeRequests.allDiffs(project_id, merge_request_iid);
                const diffText = Array.isArray(diff) && diff.length > 0
                    ? JSON.stringify(diff, null, 2)
                    : "No diff data available for this merge request.";
                return {
                    content: [{ type: "text", text: diffText }],
                };
            } catch (error) {
                return formatErrorResponse(error);
            }
        }
    );

    server.registerTool(
        "get_issue_details",
        {
            description: "Get details of an issue within a certain project",
            inputSchema: z.object({
                project_id: z.number().describe("The project ID of the issue"),
                issue_iid: z.number().describe("The internal ID of the issue within the project"),
                verbose: z.boolean().default(false).describe("By default a filtered version is returned, suitable for most cases. Only set true if more information is needed."),
            })
        },
        async ({ project_id, issue_iid, verbose }) => {
            try {
                const issue = await api.Issues.show(issue_iid, { projectId: project_id });

                const filteredIssue = verbose ? issue : {
                    title: issue.title,
                    description: issue.description,
                };

                return {
                    content: [{ type: "text", text: JSON.stringify(filteredIssue, null, 2) }],
                };
            } catch (error) {
                return formatErrorResponse(error);
            }
        }
    );

    server.registerTool(
        "set_merge_request_description",
        {
            description: "Set the description of a merge request",
            inputSchema: z.object({
                project_id: z.number().describe("The project ID of the merge request"),
                merge_request_iid: z.number().describe("The internal ID of the merge request within the project"),
                description: z.string().describe("The description text"),
            })
        },
        async ({ project_id, merge_request_iid, description }) => {
            try {
                const mr = await api.MergeRequests.edit(project_id, merge_request_iid, { description });
                return {
                    content: [{ type: "text", text: JSON.stringify(mr, null, 2) }],
                };
            } catch (error) {
                return formatErrorResponse(error);
            }
        }
    );

    server.registerTool(
        "set_merge_request_title",
        {
            description: "Set the title of a merge request",
            inputSchema: z.object({
                project_id: z.number().describe("The project ID of the merge request"),
                merge_request_iid: z.number().describe("The internal ID of the merge request within the project"),
                title: z.string().describe("The title of the merge request"),
            })
        },
        async ({ project_id, merge_request_iid, title }) => {
            try {
                const mr = await api.MergeRequests.edit(project_id, merge_request_iid, { title });
                return {
                    content: [{ type: "text", text: JSON.stringify(mr, null, 2) }],
                };
            } catch (error) {
                return formatErrorResponse(error);
            }
        }
    );

    server.registerTool(
        "create_merge_request",
        {
            description: "Create a new merge request",
            inputSchema: z.object({
                project_id: z.number().describe("The project ID of the merge request"),
                source_branch: z.string().describe("The source branch of the merge request"),
                target_branch: z.string().describe("The target branch of the merge request"),
                title: z.string().describe("The title of the merge request"),
                description: z.string().optional().describe("The description of the merge request"),
            })
        },
        async ({ project_id, source_branch, target_branch, title, description }) => {
            try {
                const mr = await api.MergeRequests.create(project_id, source_branch, target_branch, title, { description });
                return {
                    content: [{ type: "text", text: JSON.stringify(mr, null, 2) }],
                };
            } catch (error) {
                return formatErrorResponse(error);
            }
        }
    );

    return server;
}

export { getServer };
