const DEFAULT_API_BASE_URL = "http://127.0.0.1:43127";

const titleInput = document.querySelector("#title");
const urlInput = document.querySelector("#url");
const whySavedInput = document.querySelector("#why-saved");
const saveButton = document.querySelector("#save");
const status = document.querySelector("#status");
const optionsButton = document.querySelector("#open-options");

function showStatus(message, kind = "") {
	status.textContent = message;
	status.className = kind;
}

async function getActivePage() {
	const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
	if (!tab?.url || !/^https?:\/\//.test(tab.url)) {
		throw new Error("当前页面不是可保存的 HTTP/HTTPS 页面");
	}
	return { title: tab.title?.trim() || tab.url, url: tab.url };
}

async function getApiBaseUrl() {
	const stored = await chrome.storage.local.get("apiBaseUrl");
	return stored.apiBaseUrl || DEFAULT_API_BASE_URL;
}

async function saveDebt() {
	const whySaved = whySavedInput.value.trim();
	if (!whySaved) {
		showStatus("请填写为什么保存。", "error");
		whySavedInput.focus();
		return;
	}

	saveButton.disabled = true;
	showStatus("正在保存…");
	try {
		const apiBaseUrl = await getApiBaseUrl();
		const response = await fetch(`${apiBaseUrl}/v1/debts`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				url: urlInput.value,
				title: titleInput.value,
				why_saved: whySaved,
			}),
		});
		const result = await response.json();
		if (!response.ok) {
			throw new Error(result.error?.message || `HTTP ${response.status}`);
		}
		showStatus(`已保存：${result.debt.title}`, "success");
		whySavedInput.value = "";
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		showStatus(`保存失败：${message}。请确认本地 API 已启动。`, "error");
	} finally {
		saveButton.disabled = false;
	}
}

saveButton.addEventListener("click", () => {
	void saveDebt();
});

whySavedInput.addEventListener("keydown", (event) => {
	if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
		void saveDebt();
	}
});

optionsButton.addEventListener("click", () => {
	void chrome.runtime.openOptionsPage();
});

void getActivePage()
	.then((page) => {
		titleInput.value = page.title;
		urlInput.value = page.url;
		whySavedInput.focus();
	})
	.catch((error) => {
		showStatus(error instanceof Error ? error.message : String(error), "error");
		saveButton.disabled = true;
	});
