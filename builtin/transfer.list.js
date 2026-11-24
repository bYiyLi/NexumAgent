/**
{
  "scriptName": "transfer.list.js",
  "scriptDesc": "查询授权范围内的文件传输记录",
  "scriptWhenUse": "定位原有传输；不重复执行",
  "scriptOpenDefault": false,
  "scriptInputSchema": {
    "type": "object",
    "properties": {
      "direction": {
        "type": "string",
        "enum": [
          "upload",
          "download"
        ]
      },
      "status": {
        "type": "string",
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
        ]
      },
      "runId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 256
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
    "additionalProperties": false,
    "properties": {
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
      "transfers": {
        "items": {
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
        },
        "type": "array"
      }
    },
    "required": [
      "transfers",
      "nextCursor"
    ],
    "type": "object"
  }
}
*/
return await transfer.list(context.input);
