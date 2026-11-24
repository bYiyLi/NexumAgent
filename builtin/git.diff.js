/**
{
  "scriptName": "git.diff.js",
  "scriptDesc": "通过受管 sh SDK 查看 Git 工作树或暂存区的差异",
  "scriptWhenUse": "修改代码前后需要核对真实 Git Diff 时",
  "scriptOpenDefault": true,
  "scriptInputSchema": {
    "type": "object",
    "properties": {
      "path": {
        "type": "string",
        "minLength": 1,
        "maxLength": 4096
      },
      "cached": {
        "type": "boolean"
      },
      "stat": {
        "type": "boolean"
      }
    },
    "additionalProperties": false
  },
  "scriptOutputSchema": {
    "type": "object",
    "properties": {
      "processId": {
        "type": "string"
      },
      "status": {
        "type": "string"
      },
      "state": {
        "type": "string"
      },
      "lifetime": {
        "type": "string",
        "enum": [
          "run",
          "instance",
          "background"
        ]
      },
      "originRunId": {
        "anyOf": [
          {
            "type": "string"
          },
          {
            "type": "null"
          }
        ]
      },
      "contextId": {
        "anyOf": [
          {
            "type": "string"
          },
          {
            "type": "null"
          }
        ]
      },
      "origin": {
        "type": "object",
        "properties": {
          "type": {
            "type": "string",
            "enum": [
              "local",
              "platform",
              "extension"
            ]
          },
          "owner": {
            "type": "string"
          },
          "namespace": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "version": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "revision": {
            "type": "string"
          }
        },
        "required": [
          "type",
          "owner",
          "namespace",
          "version",
          "revision"
        ],
        "additionalProperties": false
      },
      "createdAt": {
        "type": "integer",
        "minimum": 0
      },
      "closedAt": {
        "anyOf": [
          {
            "type": "integer",
            "minimum": 0
          },
          {
            "type": "null"
          }
        ]
      },
      "handedOffAt": {
        "anyOf": [
          {
            "type": "integer",
            "minimum": 0
          },
          {
            "type": "null"
          }
        ]
      },
      "controlAvailable": {
        "type": "boolean"
      },
      "pid": {
        "anyOf": [
          {
            "type": "integer"
          },
          {
            "type": "null"
          }
        ]
      },
      "exitCode": {
        "anyOf": [
          {
            "type": "integer"
          },
          {
            "type": "null"
          }
        ]
      },
      "signal": {
        "anyOf": [
          {
            "type": "string"
          },
          {
            "type": "null"
          }
        ]
      },
      "outputComplete": {
        "type": "boolean"
      },
      "details": {
        "type": "object"
      },
      "output": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "stream": {
              "type": "string",
              "enum": [
                "stdout",
                "stderr",
                "terminal"
              ]
            },
            "data": {
              "anyOf": [
                {
                  "type": "string"
                },
                {
                  "type": "object",
                  "description": "Native byte value; delivery conversion is described by the Run result."
                }
              ]
            }
          },
          "required": [
            "stream",
            "data"
          ],
          "additionalProperties": false
        }
      },
      "nextCursor": {
        "anyOf": [
          {
            "type": "string"
          },
          {
            "type": "null"
          }
        ]
      },
      "hasMoreOutput": {
        "type": "boolean"
      },
      "truncated": {
        "type": "boolean"
      }
    },
    "required": [
      "processId",
      "status",
      "state",
      "lifetime",
      "originRunId",
      "contextId",
      "origin",
      "createdAt",
      "closedAt",
      "handedOffAt",
      "controlAvailable",
      "pid",
      "exitCode",
      "signal",
      "outputComplete",
      "details",
      "output",
      "nextCursor",
      "hasMoreOutput",
      "truncated"
    ],
    "additionalProperties": false
  }
}
*/
const path = await import("node:path");
const relative = context.input.path;
if (relative && (path.isAbsolute(relative) || relative.split(/[\\/]/).includes(".."))) throw Error("git_path_escape: project-relative path required");
const args = ["diff", "--no-ext-diff"];
if (context.input.cached) args.push("--cached");
if (context.input.stat) args.push("--stat");
if (relative) args.push("--", relative);
return await sh.exec({ command: "git", args, cwd: context.project?.root ?? context.pwd, timeoutMs: 15000, check: true });
