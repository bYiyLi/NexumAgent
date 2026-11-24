/**
{
  "scriptName": "sh.get.js",
  "scriptDesc": "读取原受管进程的状态和增量输出",
  "scriptWhenUse": "查询现有进程；普通 Run 已满时仍可使用",
  "scriptOpenDefault": false,
  "scriptInputSchema": {
    "type": "object",
    "properties": {
      "processId": {
        "type": "string",
        "pattern": "^res_[0-9a-f]{32}$"
      },
      "cursor": {
        "type": "string",
        "minLength": 1,
        "maxLength": 4096
      },
      "maxBytes": {
        "type": "integer",
        "minimum": 1,
        "maximum": 1048576
      },
      "waitMs": {
        "type": "integer",
        "minimum": 0,
        "maximum": 30000
      },
      "encoding": {
        "anyOf": [
          {
            "type": "string",
            "enum": [
              "ascii",
              "utf8",
              "utf-8",
              "utf16le",
              "utf-16le",
              "ucs2",
              "ucs-2",
              "base64",
              "base64url",
              "latin1",
              "binary",
              "hex"
            ]
          },
          {
            "type": "null"
          }
        ]
      }
    },
    "required": [
      "processId"
    ],
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
return await sh.get(context.input);
