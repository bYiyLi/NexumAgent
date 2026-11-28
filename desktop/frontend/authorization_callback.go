package frontend

import (
	_ "embed"
	"html/template"
	"io"
)

//go:embed authorization_callback.html
var authorizationCallbackHTML string

//go:embed public/nexum-mark.svg
var authorizationBrandMark string

var authorizationCallbackTemplate = template.Must(template.New("authorization callback").Parse(authorizationCallbackHTML))

type authorizationCallbackPage struct {
	Language string
	Title    string
	Message  string
	Close    string
	Approved bool
	Mark     template.HTML
}

// WriteAuthorizationCallback displays the result received by Desktop. The
// markup uses only fixed copy and the build-time brand asset.
func WriteAuthorizationCallback(w io.Writer, language string, approved bool) error {
	page := authorizationCallbackPage{
		Language: "en-US",
		Close:    "You can close this tab",
		Approved: approved,
		Mark:     template.HTML(authorizationBrandMark),
	}
	if language == "zh-CN" {
		page.Language = "zh-CN"
		page.Close = "可以关闭此标签页"
		if approved {
			page.Title = "已收到授权"
			page.Message = "请返回 Nexum Desktop\n查看后续进度。"
		} else {
			page.Title = "本次授权未完成"
			page.Message = "请返回 Nexum Desktop。\n如需继续，选择「重新检查」后再次授权。"
		}
	} else if approved {
		page.Title = "Authorization received"
		page.Message = "Return to Nexum Desktop to view progress."
	} else {
		page.Title = "Authorization not completed"
		page.Message = "Return to Nexum Desktop.\nTo try again, select “Check again” in the app."
	}
	return authorizationCallbackTemplate.Execute(w, page)
}
