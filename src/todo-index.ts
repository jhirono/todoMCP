import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import dotenv from "dotenv";

// Load environment variables
dotenv.config();

// Log the current working directory
console.error('Current working directory:', process.cwd());

// Microsoft Graph API endpoints
const MS_GRAPH_BASE = "https://graph.microsoft.com/v1.0";
const USER_AGENT = "ms-todo-mcp/1.0";
// Use absolute path for token file
const TOKEN_FILE_PATH = '/Users/jhirono/Dev/todoMCP/tokens.json';
console.error('Using token file path:', TOKEN_FILE_PATH);

// Create server instance
const server = new McpServer({
  name: "mstodo",
  version: "1.0.0",
});

// Token types
interface TokenData {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

// Helper to read tokens from file
function readTokens(): TokenData | null {
  try {
    console.error(`Attempting to read tokens from: ${TOKEN_FILE_PATH}`);
    if (!existsSync(TOKEN_FILE_PATH)) {
      console.error('Token file does not exist');
      return null;
    }
    const data = readFileSync(TOKEN_FILE_PATH, 'utf8');
    console.error('Token file content length:', data.length);
    
    const tokenData = JSON.parse(data) as TokenData;
    console.error('Token parsed successfully, expires at:', new Date(tokenData.expiresAt).toLocaleString());
    return tokenData;
  } catch (error) {
    console.error('Failed to read tokens from file:', error);
    return null;
  }
}

// Helper to write tokens to file
function writeTokens(tokenData: TokenData): void {
  try {
    writeFileSync(TOKEN_FILE_PATH, JSON.stringify(tokenData, null, 2), 'utf8');
  } catch (error) {
    console.error('Failed to write tokens to file:', error);
  }
}

// Helper function for making Microsoft Graph API requests
async function makeGraphRequest<T>(url: string, token: string, method = "GET", body?: any): Promise<T | null> {
  const headers = {
    "User-Agent": USER_AGENT,
    "Accept": "application/json",
    "Authorization": `Bearer ${token}`,
    "Content-Type": "application/json"
  };

  try {
    const options: RequestInit = { 
      method, 
      headers 
    };

    if (body && (method === "POST" || method === "PATCH")) {
      options.body = JSON.stringify(body);
    }

    const response = await fetch(url, options);
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    return (await response.json()) as T;
  } catch (error) {
    console.error("Error making Graph API request:", error);
    return null;
  }
}

// Refresh token function
async function refreshAccessToken(refreshToken: string): Promise<TokenData | null> {
  const tokenEndpoint = `https://login.microsoftonline.com/consumers/oauth2/v2.0/token`;
  
  const formData = new URLSearchParams({
    client_id: process.env.CLIENT_ID || "",
    client_secret: process.env.CLIENT_SECRET || "",
    refresh_token: refreshToken,
    grant_type: "refresh_token",
    scope: "Tasks.Read Tasks.ReadWrite Tasks.Read.Shared Tasks.ReadWrite.Shared"
  });

  try {
    const response = await fetch(tokenEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: formData
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Token refresh failed: ${response.status} ${errorText}`);
    }

    const data = await response.json();
    
    // Calculate expiration time (subtract 5 minutes for safety margin)
    const expiresAt = Date.now() + (data.expires_in * 1000) - (5 * 60 * 1000);
    
    const tokenData: TokenData = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token || refreshToken, // Use new refresh token if provided
      expiresAt
    };
    
    // Save the new tokens
    writeTokens(tokenData);
    
    return tokenData;
  } catch (error) {
    console.error("Error refreshing token:", error);
    return null;
  }
}

// Authentication helper using delegated flow with refresh token
async function getAccessToken(): Promise<string | null> {
  try {
    console.error('getAccessToken called');
    
    try {
      // Read token directly from the absolute path
      const tokenFilePath = '/Users/jhirono/Dev/todoMCP/tokens.json';
      console.error(`Directly reading token from: ${tokenFilePath}`);
      
      // Read file synchronously to avoid any async issues
      const data = readFileSync(tokenFilePath, 'utf8');
      console.error(`Read ${data.length} bytes from token file`);
      
      // Parse the token data
      const tokenData = JSON.parse(data) as TokenData;
      console.error(`Token parsed, expires at: ${new Date(tokenData.expiresAt).toLocaleString()}`);
      
      // Check if token is expired
      const now = Date.now();
      if (now > tokenData.expiresAt) {
        console.error(`Token is expired. Current time: ${now}, expires at: ${tokenData.expiresAt}`);
        return null;
      }
      
      // Success - return the token
      console.error(`Successfully retrieved valid token (${tokenData.accessToken.substring(0, 10)}...)`);
      return tokenData.accessToken;
    } catch (readError) {
      console.error(`Direct token read error: ${readError}`);
      return null;
    }
  } catch (error) {
    console.error("Error getting access token:", error);
    return null;
  }
}

// Server tool to check authentication status
server.tool(
  "auth-status",
  "Check if you're authenticated with Microsoft Graph API. Shows current token status and expiration time, and indicates if the token needs to be refreshed.",
  {},
  async () => {
    const tokens = readTokens();
    if (!tokens) {
      return {
        content: [
          {
            type: "text",
            text: "Not authenticated. Please run auth-server.js to authenticate with Microsoft.",
          },
        ],
      };
    }
    
    const isExpired = Date.now() > tokens.expiresAt;
    const expiryTime = new Date(tokens.expiresAt).toLocaleString();
    
    if (isExpired) {
      return {
        content: [
          {
            type: "text",
            text: `Authentication expired at ${expiryTime}. Will attempt to refresh when you call any API.`,
          },
        ],
      };
    } else {
      return {
        content: [
          {
            type: "text",
            text: `Authenticated. Token expires at ${expiryTime}.`,
          },
        ],
      };
    }
  }
);

interface TaskList {
  id: string;
  displayName: string;
  isOwner?: boolean;
  isShared?: boolean;
  wellknownListName?: string; // 'none', 'defaultList', 'flaggedEmails', 'unknownFutureValue'
}

interface Task {
  id: string;
  title: string;
  status: string;
  importance: string;
  dueDateTime?: {
    dateTime: string;
    timeZone: string;
  };
  body?: {
    content: string;
    contentType: string;
  };
  categories?: string[];
}

interface ChecklistItem {
  id: string;
  displayName: string;
  isChecked: boolean;
  createdDateTime?: string;
}

// Register tools
server.tool(
  "get-task-lists",
  "Get all Microsoft Todo task lists (the top-level containers that organize your tasks). Shows list names, IDs, and indicates default or shared lists.",
  {},
  async () => {
    try {
      const token = await getAccessToken();
      if (!token) {
        return {
          content: [
            {
              type: "text",
              text: "Failed to authenticate with Microsoft API",
            },
          ],
        };
      }

      const response = await makeGraphRequest<{ value: TaskList[] }>(
        `${MS_GRAPH_BASE}/me/todo/lists`,
        token
      );

      if (!response) {
        return {
          content: [
            {
              type: "text",
              text: "Failed to retrieve task lists",
            },
          ],
        };
      }

      const lists = response.value || [];
      if (lists.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "No task lists found.",
            },
          ],
        };
      }

      const formattedLists = lists.map((list) => {
        // Add well-known list name if applicable
        let wellKnownInfo = "";
        if (list.wellknownListName && list.wellknownListName !== "none") {
          if (list.wellknownListName === "defaultList") {
            wellKnownInfo = " (Default Tasks List)";
          } else if (list.wellknownListName === "flaggedEmails") {
            wellKnownInfo = " (Flagged Emails)";
          }
        }
        
        // Add sharing info if applicable
        let sharingInfo = "";
        if (list.isShared) {
          sharingInfo = list.isOwner ? " (Shared by you)" : " (Shared with you)";
        }
        
        return `ID: ${list.id}\nName: ${list.displayName}${wellKnownInfo}${sharingInfo}\n---`;
      });

      return {
        content: [
          {
            type: "text",
            text: `Your task lists:\n\n${formattedLists.join("\n")}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error fetching task lists: ${error}`,
          },
        ],
      };
    }
  }
);

server.tool(
  "create-task-list",
  "Create a new task list (top-level container) in Microsoft Todo to help organize your tasks into categories or projects.",
  {
    displayName: z.string().describe("Name of the new task list")
  },
  async ({ displayName }) => {
    try {
      const token = await getAccessToken();
      if (!token) {
        return {
          content: [
            {
              type: "text",
              text: "Failed to authenticate with Microsoft API",
            },
          ],
        };
      }

      // Prepare the request body
      const requestBody = {
        displayName
      };

      // Make the API request to create the task list
      const response = await makeGraphRequest<TaskList>(
        `${MS_GRAPH_BASE}/me/todo/lists`,
        token,
        "POST",
        requestBody
      );
      
      if (!response) {
        return {
          content: [
            {
              type: "text",
              text: `Failed to create task list: ${displayName}`,
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text",
            text: `Task list created successfully!\nName: ${response.displayName}\nID: ${response.id}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error creating task list: ${error}`,
          },
        ],
      };
    }
  }
);

server.tool(
  "update-task-list",
  "Update the name of an existing task list (top-level container) in Microsoft Todo.",
  {
    listId: z.string().describe("ID of the task list to update"),
    displayName: z.string().describe("New name for the task list")
  },
  async ({ listId, displayName }) => {
    try {
      const token = await getAccessToken();
      if (!token) {
        return {
          content: [
            {
              type: "text",
              text: "Failed to authenticate with Microsoft API",
            },
          ],
        };
      }

      // Prepare the request body
      const requestBody = {
        displayName
      };

      // Make the API request to update the task list
      const response = await makeGraphRequest<TaskList>(
        `${MS_GRAPH_BASE}/me/todo/lists/${listId}`,
        token,
        "PATCH",
        requestBody
      );
      
      if (!response) {
        return {
          content: [
            {
              type: "text",
              text: `Failed to update task list with ID: ${listId}`,
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text",
            text: `Task list updated successfully!\nNew name: ${response.displayName}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error updating task list: ${error}`,
          },
        ],
      };
    }
  }
);

server.tool(
  "delete-task-list",
  "Delete a task list (top-level container) from Microsoft Todo. This will remove the list and all tasks within it.",
  {
    listId: z.string().describe("ID of the task list to delete")
  },
  async ({ listId }) => {
    try {
      const token = await getAccessToken();
      if (!token) {
        return {
          content: [
            {
              type: "text",
              text: "Failed to authenticate with Microsoft API",
            },
          ],
        };
      }

      // Make a DELETE request to the Microsoft Graph API
      const url = `${MS_GRAPH_BASE}/me/todo/lists/${listId}`;
      console.error(`Deleting task list: ${url}`);
      
      // The DELETE method doesn't return a response body, so we expect null
      await makeGraphRequest<null>(
        url,
        token,
        "DELETE"
      );
      
      // If we get here, the delete was successful (204 No Content)
      return {
        content: [
          {
            type: "text",
            text: `Task list with ID: ${listId} was successfully deleted.`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error deleting task list: ${error}`,
          },
        ],
      };
    }
  }
);

server.tool(
  "get-tasks",
  "Get tasks from a specific Microsoft Todo list. These are the main todo items that can contain checklist items (subtasks).",
  {
    listId: z.string().describe("ID of the task list"),
    filter: z.string().optional().describe("OData $filter query (e.g., 'status eq \\'completed\\'')"),
    select: z.string().optional().describe("Comma-separated list of properties to include (e.g., 'id,title,status')"),
    orderby: z.string().optional().describe("Property to sort by (e.g., 'createdDateTime desc')"),
    top: z.number().optional().describe("Maximum number of tasks to retrieve"),
    skip: z.number().optional().describe("Number of tasks to skip"),
    count: z.boolean().optional().describe("Whether to include a count of tasks")
  },
  async ({ listId, filter, select, orderby, top, skip, count }) => {
    try {
      const token = await getAccessToken();
      if (!token) {
        return {
          content: [
            {
              type: "text",
              text: "Failed to authenticate with Microsoft API",
            },
          ],
        };
      }

      // Build the query parameters
      const queryParams = new URLSearchParams();
      
      if (filter) queryParams.append('$filter', filter);
      if (select) queryParams.append('$select', select);
      if (orderby) queryParams.append('$orderby', orderby);
      if (top !== undefined) queryParams.append('$top', top.toString());
      if (skip !== undefined) queryParams.append('$skip', skip.toString());
      if (count !== undefined) queryParams.append('$count', count.toString());
      
      // Construct the URL with query parameters
      const queryString = queryParams.toString();
      const url = `${MS_GRAPH_BASE}/me/todo/lists/${listId}/tasks${queryString ? '?' + queryString : ''}`;
      
      console.error(`Making request to: ${url}`);

      const response = await makeGraphRequest<{ value: Task[], '@odata.count'?: number }>(
        url,
        token
      );
      
      if (!response) {
        return {
          content: [
            {
              type: "text",
              text: `Failed to retrieve tasks for list: ${listId}`,
            },
          ],
        };
      }

      const tasks = response.value || [];
      if (tasks.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `No tasks found in list with ID: ${listId}`,
            },
          ],
        };
      }

      // Format the tasks based on available properties
      const formattedTasks = tasks.map((task) => {
        // Default format
        let taskInfo = `ID: ${task.id}\nTitle: ${task.title}`;
        
        // Add status if available
        if (task.status) {
          const status = task.status === "completed" ? "✓" : "○";
          taskInfo = `${status} ${taskInfo}`;
        }
        
        // Add due date if available
        if (task.dueDateTime) {
          taskInfo += `\nDue: ${new Date(task.dueDateTime.dateTime).toLocaleDateString()}`;
        }
        
        // Add importance if available
        if (task.importance) {
          taskInfo += `\nImportance: ${task.importance}`;
        }
        
        // Add categories if available
        if (task.categories && task.categories.length > 0) {
          taskInfo += `\nCategories: ${task.categories.join(', ')}`;
        }
        
        // Add body content if available and not empty
        if (task.body && task.body.content && task.body.content.trim() !== '') {
          const previewLength = 50;
          const contentPreview = task.body.content.length > previewLength 
            ? task.body.content.substring(0, previewLength) + '...' 
            : task.body.content;
          taskInfo += `\nDescription: ${contentPreview}`;
        }
        
        return `${taskInfo}\n---`;
      });

      // Add count information if requested and available
      let countInfo = '';
      if (count && response['@odata.count'] !== undefined) {
        countInfo = `Total count: ${response['@odata.count']}\n\n`;
      }

      return {
        content: [
          {
            type: "text",
            text: `Tasks in list ${listId}:\n\n${countInfo}${formattedTasks.join("\n")}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error fetching tasks: ${error}`,
          },
        ],
      };
    }
  }
);

server.tool(
  "create-task",
  "Create a new task in a specific Microsoft Todo list. A task is the main todo item that can have a title, description, due date, and other properties.",
  {
    listId: z.string().describe("ID of the task list"),
    title: z.string().describe("Title of the task"),
    body: z.string().optional().describe("Description or body content of the task"),
    dueDateTime: z.string().optional().describe("Due date in ISO format (e.g., 2023-12-31T23:59:59Z)"),
    startDateTime: z.string().optional().describe("Start date in ISO format (e.g., 2023-12-31T23:59:59Z)"),
    importance: z.enum(["low", "normal", "high"]).optional().describe("Task importance"),
    isReminderOn: z.boolean().optional().describe("Whether to enable reminder for this task"),
    reminderDateTime: z.string().optional().describe("Reminder date and time in ISO format"),
    status: z.enum(["notStarted", "inProgress", "completed", "waitingOnOthers", "deferred"]).optional().describe("Status of the task"),
    categories: z.array(z.string()).optional().describe("Categories associated with the task")
  },
  async ({ listId, title, body, dueDateTime, startDateTime, importance, isReminderOn, reminderDateTime, status, categories }) => {
    try {
      const token = await getAccessToken();
      if (!token) {
        return {
          content: [
            {
              type: "text",
              text: "Failed to authenticate with Microsoft API",
            },
          ],
        };
      }

      // Construct the task body with all supported properties
      const taskBody: any = { title };
      
      // Add optional properties if provided
      if (body) {
        taskBody.body = {
          content: body,
          contentType: "text"
        };
      }
      
      if (dueDateTime) {
        taskBody.dueDateTime = {
          dateTime: dueDateTime,
          timeZone: "UTC",
        };
      }
      
      if (startDateTime) {
        taskBody.startDateTime = {
          dateTime: startDateTime,
          timeZone: "UTC",
        };
      }
      
      if (importance) {
        taskBody.importance = importance;
      }
      
      if (isReminderOn !== undefined) {
        taskBody.isReminderOn = isReminderOn;
      }
      
      if (reminderDateTime) {
        taskBody.reminderDateTime = {
          dateTime: reminderDateTime,
          timeZone: "UTC",
        };
      }
      
      if (status) {
        taskBody.status = status;
      }
      
      if (categories && categories.length > 0) {
        taskBody.categories = categories;
      }

      const response = await makeGraphRequest<Task>(
        `${MS_GRAPH_BASE}/me/todo/lists/${listId}/tasks`,
        token,
        "POST",
        taskBody
      );
      
      if (!response) {
        return {
          content: [
            {
              type: "text",
              text: `Failed to create task in list: ${listId}`,
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text",
            text: `Task created successfully!\nID: ${response.id}\nTitle: ${response.title}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error creating task: ${error}`,
          },
        ],
      };
    }
  }
);

server.tool(
  "update-task",
  "Update an existing task in Microsoft Todo. Allows changing any properties of the task including title, due date, importance, etc.",
  {
    listId: z.string().describe("ID of the task list"),
    taskId: z.string().describe("ID of the task to update"),
    title: z.string().optional().describe("New title of the task"),
    body: z.string().optional().describe("New description or body content of the task"),
    dueDateTime: z.string().optional().describe("New due date in ISO format (e.g., 2023-12-31T23:59:59Z)"),
    startDateTime: z.string().optional().describe("New start date in ISO format (e.g., 2023-12-31T23:59:59Z)"),
    importance: z.enum(["low", "normal", "high"]).optional().describe("New task importance"),
    isReminderOn: z.boolean().optional().describe("Whether to enable reminder for this task"),
    reminderDateTime: z.string().optional().describe("New reminder date and time in ISO format"),
    status: z.enum(["notStarted", "inProgress", "completed", "waitingOnOthers", "deferred"]).optional().describe("New status of the task"),
    categories: z.array(z.string()).optional().describe("New categories associated with the task")
  },
  async ({ listId, taskId, title, body, dueDateTime, startDateTime, importance, isReminderOn, reminderDateTime, status, categories }) => {
    try {
      const token = await getAccessToken();
      if (!token) {
        return {
          content: [
            {
              type: "text",
              text: "Failed to authenticate with Microsoft API",
            },
          ],
        };
      }

      // Construct the task update body with all provided properties
      const taskBody: any = {};
      
      // Add optional properties if provided
      if (title !== undefined) {
        taskBody.title = title;
      }
      
      if (body !== undefined) {
        taskBody.body = {
          content: body,
          contentType: "text"
        };
      }
      
      if (dueDateTime !== undefined) {
        if (dueDateTime === "") {
          // Remove the due date by setting it to null
          taskBody.dueDateTime = null;
        } else {
          taskBody.dueDateTime = {
            dateTime: dueDateTime,
            timeZone: "UTC",
          };
        }
      }
      
      if (startDateTime !== undefined) {
        if (startDateTime === "") {
          // Remove the start date by setting it to null
          taskBody.startDateTime = null;
        } else {
          taskBody.startDateTime = {
            dateTime: startDateTime,
            timeZone: "UTC",
          };
        }
      }
      
      if (importance !== undefined) {
        taskBody.importance = importance;
      }
      
      if (isReminderOn !== undefined) {
        taskBody.isReminderOn = isReminderOn;
      }
      
      if (reminderDateTime !== undefined) {
        if (reminderDateTime === "") {
          // Remove the reminder date by setting it to null
          taskBody.reminderDateTime = null;
        } else {
          taskBody.reminderDateTime = {
            dateTime: reminderDateTime,
            timeZone: "UTC",
          };
        }
      }
      
      if (status !== undefined) {
        taskBody.status = status;
      }
      
      if (categories !== undefined) {
        taskBody.categories = categories;
      }
      
      // Make sure we have at least one property to update
      if (Object.keys(taskBody).length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "No properties provided for update. Please specify at least one property to change.",
            },
          ],
        };
      }

      const response = await makeGraphRequest<Task>(
        `${MS_GRAPH_BASE}/me/todo/lists/${listId}/tasks/${taskId}`,
        token,
        "PATCH",
        taskBody
      );
      
      if (!response) {
        return {
          content: [
            {
              type: "text",
              text: `Failed to update task with ID: ${taskId} in list: ${listId}`,
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text",
            text: `Task updated successfully!\nID: ${response.id}\nTitle: ${response.title}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error updating task: ${error}`,
          },
        ],
      };
    }
  }
);

server.tool(
  "delete-task",
  "Delete a task from a Microsoft Todo list. This will remove the task and all its checklist items (subtasks).",
  {
    listId: z.string().describe("ID of the task list"),
    taskId: z.string().describe("ID of the task to delete")
  },
  async ({ listId, taskId }) => {
    try {
      const token = await getAccessToken();
      if (!token) {
        return {
          content: [
            {
              type: "text",
              text: "Failed to authenticate with Microsoft API",
            },
          ],
        };
      }

      // Make a DELETE request to the Microsoft Graph API
      const url = `${MS_GRAPH_BASE}/me/todo/lists/${listId}/tasks/${taskId}`;
      console.error(`Deleting task: ${url}`);
      
      // The DELETE method doesn't return a response body, so we expect null
      await makeGraphRequest<null>(
        url,
        token,
        "DELETE"
      );
      
      // If we get here, the delete was successful (204 No Content)
      return {
        content: [
          {
            type: "text",
            text: `Task with ID: ${taskId} was successfully deleted from list: ${listId}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error deleting task: ${error}`,
          },
        ],
      };
    }
  }
);

server.tool(
  "get-checklist-items",
  "Get checklist items (subtasks) for a specific task. Checklist items are smaller steps or components that belong to a parent task.",
  {
    listId: z.string().describe("ID of the task list"),
    taskId: z.string().describe("ID of the task"),
  },
  async ({ listId, taskId }) => {
    try {
      const token = await getAccessToken();
      if (!token) {
        return {
          content: [
            {
              type: "text",
              text: "Failed to authenticate with Microsoft API",
            },
          ],
        };
      }

      // Fetch the task first to get its title
      const taskResponse = await makeGraphRequest<Task>(
        `${MS_GRAPH_BASE}/me/todo/lists/${listId}/tasks/${taskId}`,
        token
      );
      
      const taskTitle = taskResponse ? taskResponse.title : "Unknown Task";

      // Fetch the checklist items
      const response = await makeGraphRequest<{ value: ChecklistItem[] }>(
        `${MS_GRAPH_BASE}/me/todo/lists/${listId}/tasks/${taskId}/checklistItems`,
        token
      );
      
      if (!response) {
        return {
          content: [
            {
              type: "text",
              text: `Failed to retrieve checklist items for task: ${taskId}`,
            },
          ],
        };
      }

      const items = response.value || [];
      if (items.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `No checklist items found for task "${taskTitle}" (ID: ${taskId})`,
            },
          ],
        };
      }

      const formattedItems = items.map((item) => {
        const status = item.isChecked ? "✓" : "○";
        let itemInfo = `${status} ${item.displayName} (ID: ${item.id})`;
        
        // Add creation date if available
        if (item.createdDateTime) {
          const createdDate = new Date(item.createdDateTime).toLocaleString();
          itemInfo += `\nCreated: ${createdDate}`;
        }
        
        return itemInfo;
      });

      return {
        content: [
          {
            type: "text",
            text: `Checklist items for task "${taskTitle}" (ID: ${taskId}):\n\n${formattedItems.join("\n\n")}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error fetching checklist items: ${error}`,
          },
        ],
      };
    }
  }
);

server.tool(
  "create-checklist-item",
  "Create a new checklist item (subtask) for a task. Checklist items help break down a task into smaller, manageable steps.",
  {
    listId: z.string().describe("ID of the task list"),
    taskId: z.string().describe("ID of the task"),
    displayName: z.string().describe("Text content of the checklist item"),
    isChecked: z.boolean().optional().describe("Whether the item is checked off")
  },
  async ({ listId, taskId, displayName, isChecked }) => {
    try {
      const token = await getAccessToken();
      if (!token) {
        return {
          content: [
            {
              type: "text",
              text: "Failed to authenticate with Microsoft API",
            },
          ],
        };
      }

      // Prepare the request body
      const requestBody: any = {
        displayName
      };

      if (isChecked !== undefined) {
        requestBody.isChecked = isChecked;
      }

      // Make the API request to create the checklist item
      const response = await makeGraphRequest<ChecklistItem>(
        `${MS_GRAPH_BASE}/me/todo/lists/${listId}/tasks/${taskId}/checklistItems`,
        token,
        "POST",
        requestBody
      );
      
      if (!response) {
        return {
          content: [
            {
              type: "text",
              text: `Failed to create checklist item for task: ${taskId}`,
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text",
            text: `Checklist item created successfully!\nContent: ${response.displayName}\nID: ${response.id}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error creating checklist item: ${error}`,
          },
        ],
      };
    }
  }
);

server.tool(
  "update-checklist-item",
  "Update an existing checklist item (subtask). Allows changing the text content or completion status of the subtask.",
  {
    listId: z.string().describe("ID of the task list"),
    taskId: z.string().describe("ID of the task"),
    checklistItemId: z.string().describe("ID of the checklist item to update"),
    displayName: z.string().optional().describe("New text content of the checklist item"),
    isChecked: z.boolean().optional().describe("Whether the item is checked off")
  },
  async ({ listId, taskId, checklistItemId, displayName, isChecked }) => {
    try {
      const token = await getAccessToken();
      if (!token) {
        return {
          content: [
            {
              type: "text",
              text: "Failed to authenticate with Microsoft API",
            },
          ],
        };
      }

      // Prepare the update body, including only the fields that are provided
      const requestBody: any = {};
      
      if (displayName !== undefined) {
        requestBody.displayName = displayName;
      }
      
      if (isChecked !== undefined) {
        requestBody.isChecked = isChecked;
      }
      
      // Make sure we have at least one property to update
      if (Object.keys(requestBody).length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "No properties provided for update. Please specify either displayName or isChecked.",
            },
          ],
        };
      }

      // Make the API request to update the checklist item
      const response = await makeGraphRequest<ChecklistItem>(
        `${MS_GRAPH_BASE}/me/todo/lists/${listId}/tasks/${taskId}/checklistItems/${checklistItemId}`,
        token,
        "PATCH",
        requestBody
      );
      
      if (!response) {
        return {
          content: [
            {
              type: "text",
              text: `Failed to update checklist item with ID: ${checklistItemId}`,
            },
          ],
        };
      }

      const statusText = response.isChecked ? "Checked" : "Not checked";
      
      return {
        content: [
          {
            type: "text",
            text: `Checklist item updated successfully!\nContent: ${response.displayName}\nStatus: ${statusText}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error updating checklist item: ${error}`,
          },
        ],
      };
    }
  }
);

server.tool(
  "delete-checklist-item",
  "Delete a checklist item (subtask) from a task. This removes just the specific subtask, not the parent task.",
  {
    listId: z.string().describe("ID of the task list"),
    taskId: z.string().describe("ID of the task"),
    checklistItemId: z.string().describe("ID of the checklist item to delete")
  },
  async ({ listId, taskId, checklistItemId }) => {
    try {
      const token = await getAccessToken();
      if (!token) {
        return {
          content: [
            {
              type: "text",
              text: "Failed to authenticate with Microsoft API",
            },
          ],
        };
      }

      // Make a DELETE request to the Microsoft Graph API
      const url = `${MS_GRAPH_BASE}/me/todo/lists/${listId}/tasks/${taskId}/checklistItems/${checklistItemId}`;
      console.error(`Deleting checklist item: ${url}`);
      
      // The DELETE method doesn't return a response body, so we expect null
      await makeGraphRequest<null>(
        url,
        token,
        "DELETE"
      );
      
      // If we get here, the delete was successful (204 No Content)
      return {
        content: [
          {
            type: "text",
            text: `Checklist item with ID: ${checklistItemId} was successfully deleted from task: ${taskId}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error deleting checklist item: ${error}`,
          },
        ],
      };
    }
  }
);

// Main function to start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Microsoft Todo MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
}); 