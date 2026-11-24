/**
{
  "scriptName": "git.status.js",
  "scriptDesc": "通过受管 sh SDK 查询当前项目的 Git 分支和工作树变更",
  "scriptWhenUse": "需要检查当前仓库是否存在未提交更改时",
  "scriptOpenDefault": true,
  "scriptInputSchema": {
    "type": "object",
    "properties": {},
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
const cwd = context.project?.root ?? context.pwd;
return await sh.exec({ command: "git", args: ["status", "--porcelain=v1", "--branch", "-uall"], cwd, timeoutMs: 15000, check: true });
