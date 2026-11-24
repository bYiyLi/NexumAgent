/**
{
  "scriptName": "transfer.cancel.js",
  "scriptDesc": "取消原文件传输",
  "scriptWhenUse": "请求停止已有上传或下载；回读实际状态",
  "scriptOpenDefault": false,
  "scriptInputSchema": {
    "type": "object",
    "properties": {
      "transferId": {
        "type": "string",
        "pattern": "^tr_[0-9a-f]{32}$"
      }
    },
    "required": [
      "transferId"
    ],
    "additionalProperties": false
  },
  "scriptOutputSchema": {
    "additionalProperties": false,
    "properties": {
      "accepted": {
        "type": "boolean"
      },
      "transfer": {
        "additionalProperties": false,
        "properties": {
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
          "createdAt": {
            "type": "string"
          },
          "deadlineAt": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "direction": {
            "enum": [
              "upload",
              "download"
            ],
            "type": "string"
          },
          "error": {
            "anyOf": [
              {
                "type": "object"
              },
              {
                "type": "null"
              }
            ]
          },
          "expiresAt": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "file": {
            "additionalProperties": false,
            "properties": {
              "mimeType": {
                "type": "string"
              },
              "name": {
                "type": "string"
              },
              "path": {
                "type": "string"
              },
              "revision": {
                "type": "string"
              },
              "sha256": {
                "type": "string"
              },
              "size": {
                "minimum": 0,
                "type": "integer"
              }
            },
            "required": [
              "path",
              "name",
              "size",
              "mimeType",
              "sha256",
              "revision"
            ],
            "type": "object"
          },
          "finishedAt": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "maxBytes": {
            "anyOf": [
              {
                "minimum": 0,
                "type": "integer"
              },
              {
                "type": "null"
              }
            ]
          },
          "path": {
            "type": "string"
          },
          "progress": {
            "additionalProperties": false,
            "properties": {
              "bytesTransferred": {
                "minimum": 0,
                "type": "integer"
              },
              "totalBytes": {
                "anyOf": [
                  {
                    "minimum": 0,
                    "type": "integer"
                  },
                  {
                    "type": "null"
                  }
                ]
              }
            },
            "required": [
              "bytesTransferred",
              "totalBytes"
            ],
            "type": "object"
          },
          "projectId": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "resource": {
            "additionalProperties": false,
            "properties": {
              "mimeType": {
                "type": "string"
              },
              "name": {
                "type": "string"
              },
              "size": {
                "anyOf": [
                  {
                    "minimum": 0,
                    "type": "integer"
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "uri": {
                "type": "string"
              }
            },
            "required": [
              "uri",
              "name",
              "mimeType",
              "size"
            ],
            "type": "object"
          },
          "runId": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "startedAt": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "status": {
            "enum": [
              "preparing",
              "pending",
              "transferring",
              "cancelling",
              "succeeded",
              "failed",
              "cancelled",
              "expired",
              "interrupted"
            ],
            "type": "string"
          },
          "transferId": {
            "type": "string"
          }
        },
        "required": [
          "transferId",
          "direction",
          "status",
          "runId",
          "contextId",
          "projectId",
          "maxBytes",
          "progress",
          "createdAt",
          "expiresAt",
          "startedAt",
          "deadlineAt",
          "finishedAt",
          "error"
        ],
        "type": "object"
      }
    },
    "required": [
      "accepted",
      "transfer"
    ],
    "type": "object"
  }
}
*/
return await transfer.cancel(context.input.transferId);
