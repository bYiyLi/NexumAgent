/**
{
  "scriptName": "sh.stop.js",
  "scriptDesc": "停止原进程及受管后代",
  "scriptWhenUse": "普通 Run 已满时停止已有进程；以 confirmed 和 facts 判断真实收尾",
  "scriptOpenDefault": false,
  "scriptInputSchema": {
    "type": "object",
    "properties": {
      "processId": {
        "type": "string",
        "pattern": "^res_[0-9a-f]{32}$"
      },
      "graceMs": {
        "type": "integer",
        "minimum": 0,
        "maximum": 30000
      },
      "forceMs": {
        "type": "integer",
        "minimum": 0,
        "maximum": 30000
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
      "accepted": {
        "type": "boolean"
      },
      "confirmed": {
        "type": "boolean"
      },
      "facts": {
        "type": "object",
        "properties": {
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
          "startedAt": {
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
          "rootExited": {
            "type": "boolean"
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
          "exitSignal": {
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
          "treeStopped": {
            "type": "boolean"
          },
          "closed": {
            "type": "boolean"
          },
          "stopRequested": {
            "type": "boolean"
          },
          "forceRequested": {
            "type": "boolean"
          }
        },
        "required": [
          "pid",
          "startedAt",
          "rootExited",
          "exitCode",
          "exitSignal",
          "outputComplete",
          "treeStopped",
          "closed",
          "stopRequested",
          "forceRequested"
        ],
        "additionalProperties": false
      }
    },
    "required": [
      "processId",
      "accepted",
      "confirmed",
      "facts"
    ],
    "additionalProperties": false
  }
}
*/
return await sh.stop(context.input);
