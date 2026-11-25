/**
{
  "scriptName": "sh.get.js",
  "scriptDesc": "读取原受管进程的状态和增量输出",
  "scriptWhenUse": "查询现有进程；需要转码时使用已确认的 encoding 并从头读取；普通 Run 已满时仍可使用",
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
              "auto",
              "utf8",
              "utf-8",
              "cp65001",
              "utf16le",
              "utf-16le",
              "ucs2",
              "ucs-2",
              "cp1200",
              "utf16be",
              "utf-16be",
              "cp1201",
              "latin1",
              "binary",
              "ascii",
              "base64",
              "base64url",
              "hex",
              "gbk",
              "gb2312",
              "cp936",
              "gb18030",
              "cp54936",
              "shift_jis",
              "shift-jis",
              "sjis",
              "windows-31j",
              "cp932",
              "big5",
              "cp950",
              "euc-kr",
              "cp949",
              "windows-874",
              "cp874",
              "ibm866",
              "cp866",
              "cp437",
              "cp850",
              "cp852",
              "cp855",
              "cp857",
              "cp858",
              "cp860",
              "cp861",
              "cp862",
              "cp863",
              "cp864",
              "cp865",
              "cp869",
              "windows-1250",
              "cp1250",
              "windows-1251",
              "cp1251",
              "windows-1252",
              "cp1252",
              "windows-1253",
              "cp1253",
              "windows-1254",
              "cp1254",
              "windows-1255",
              "cp1255",
              "windows-1256",
              "cp1256",
              "windows-1257",
              "cp1257",
              "windows-1258",
              "cp1258"
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
