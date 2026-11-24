/**
{
  "scriptName": "sh.list.js",
  "scriptDesc": "查询授权范围内的受管进程",
  "scriptWhenUse": "定位原有进程；普通 Run 已满时仍可使用",
  "scriptOpenDefault": false,
  "scriptInputSchema": {
    "type": "object",
    "properties": {
      "status": {
        "type": "string",
        "minLength": 1,
        "maxLength": 1024
      },
      "state": {
        "type": "string",
        "minLength": 1,
        "maxLength": 1024
      },
      "runId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 1024
      },
      "contextId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 1024
      },
      "limit": {
        "type": "integer",
        "minimum": 1,
        "maximum": 100
      },
      "cursor": {
        "type": "string",
        "minLength": 1,
        "maxLength": 4096
      }
    },
    "required": [],
    "additionalProperties": false
  },
  "scriptOutputSchema": {
    "type": "object",
    "properties": {
      "items": {
        "type": "array",
        "items": {
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
            "details"
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
      }
    },
    "required": [
      "items",
      "nextCursor"
    ],
    "additionalProperties": false
  }
}
*/
return await sh.list(context.input);
