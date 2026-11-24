/**
{
  "scriptName": "sh.signal.js",
  "scriptDesc": "向原进程投递受支持的信号",
  "scriptWhenUse": "投递不代表退出；回读原进程",
  "scriptOpenDefault": false,
  "scriptInputSchema": {
    "type": "object",
    "properties": {
      "processId": {
        "type": "string",
        "pattern": "^res_[0-9a-f]{32}$"
      },
      "signal": {
        "type": "string",
        "pattern": "^SIG[A-Z0-9]+$",
        "maxLength": 32
      }
    },
    "required": [
      "processId",
      "signal"
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
      "requested": {
        "type": "string"
      },
      "delivered": {
        "type": "boolean"
      },
      "mechanism": {
        "type": "string",
        "enum": [
          "process-group",
          "job-object",
          "terminal-input"
        ]
      }
    },
    "required": [
      "processId",
      "requested",
      "delivered",
      "mechanism"
    ],
    "additionalProperties": false
  }
}
*/
return await sh.signal(context.input);
