const DEFAULT_API_BASE_URL = "http://127.0.0.1:43127";
const apiBaseUrlInput = document.querySelector("#api-base-url");
const saveButton = document.querySelector("#save");
const status = document.querySelector("#status");

function normalizeApiBaseUrl(value) {
	const url = new URL(value);
	if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") {
		throw new Error("API 地址必须使用 http://127.0.0.1");
	}
	url.pathname = "";
	url.search = "";
	url.hash = "";
	return url.toString().replace(/\/$/, "");
}

void chrome.storage.local.get("apiBaseUrl").then((stored) => {
	apiBaseUrlInput.value = stored.apiBaseUrl || DEFAULT_API_BASE_URL;
});

saveButton.addEventListener("click", () => {
	try {
		const apiBaseUrl = normalizeApiBaseUrl(apiBaseUrlInput.value);
		void chrome.storage.local.set({ apiBaseUrl }).then(() => {
			status.textContent = "设置已保存。";
			status.className = "success";
		});
	} catch (error) {
		status.textContent = error instanceof Error ? error.message : String(error);
		status.className = "error";
	}
});
