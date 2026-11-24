/**
{
  "scriptName": "sh.resize.js",
  "scriptDesc": "调整受管 PTY 尺寸",
  "scriptWhenUse": "仅调整已有 PTY",
  "scriptOpenDefault": false,
  "scriptInputSchema": {
    "type": "object",
    "properties": {
      "processId": {
        "type": "string",
        "pattern": "^res_[0-9a-f]{32}$"
      },
      "cols": {
        "type": "integer",
        "minimum": 1,
        "maximum": 1000
      },
      "rows": {
        "type": "integer",
        "minimum": 1,
        "maximum": 1000
      }
    },
    "required": [
      "processId",
      "cols",
      "rows"
    ],
    "additionalProperties": false
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
      "cols": {
        "type": "integer"
      },
      "rows": {
        "type": "integer"
      }
    },
    "required": [
      "processId",
      "accepted",
      "cols",
      "rows"
    ],
    "additionalProperties": false
  }
}
*/
return await sh.resize(context.input);
