/**
{
  "scriptName": "sh.write.js",
  "scriptDesc": "向原受管进程写入文本或关闭 stdin",
  "scriptWhenUse": "向已有交互进程提交输入；不启动进程",
  "scriptOpenDefault": false,
  "scriptInputSchema": {
    "type": "object",
    "properties": {
      "processId": {
        "type": "string",
        "pattern": "^res_[0-9a-f]{32}$"
      },
      "data": {
        "type": "string",
        "maxLength": 1048576
      },
      "eof": {
        "type": "boolean"
      }
    },
    "required": [
      "processId"
    ],
    "additionalProperties": false,
    "anyOf": [
      {
        "required": [
          "data"
        ],
        "properties": {
          "data": {}
        }
      },
      {
        "required": [
          "eof"
        ],
        "properties": {
          "eof": {
            "const": true
          }
        }
      }
    ]
  },
  "scriptOutputSchema": {
    "type": "object",
    "properties": {
      "processId": {
        "type": "string",
        "pattern": "^res_[0-9a-f]{32}$"
      },
      "accepted": {
        "const": true
      },
      "bytes": {
        "type": "integer",
        "minimum": 0
      },
      "eof": {
        "type": "boolean"
      }
    },
    "required": [
      "processId",
      "accepted",
      "bytes",
      "eof"
    ],
    "additionalProperties": false
  }
}
*/
return await sh.write(context.input);
