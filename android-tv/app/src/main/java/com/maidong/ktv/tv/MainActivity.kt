package com.maidong.ktv.tv

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Bundle
import android.view.KeyEvent
import android.view.View
import android.view.Window
import android.view.WindowManager
import android.webkit.CookieManager
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import java.io.BufferedReader
import java.net.HttpURLConnection
import java.net.Inet4Address
import java.net.NetworkInterface
import java.net.URL
import java.util.Collections
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/**
 * 麦动KTV 电视端 —— WebView 壳。
 * 自动扫描局域网 8080 端口上的 maidong-ktv-server（/api/v1/health 指纹校验），
 * 命中后加载其 /tv 大屏页面；也支持手动输入 NAS IP。
 */
class MainActivity : AppCompatActivity() {
    private lateinit var root: FrameLayout
    private lateinit var webView: WebView
    private var fullscreenView: View? = null
    private var fullscreenCallback: WebChromeClient.CustomViewCallback? = null
    private var connectionExecutor: ExecutorService? = null
    private var setupGeneration = 0
    private var pageLoaded = false

    private val prefs by lazy { getSharedPreferences(PREFS, Context.MODE_PRIVATE) }
    private val configuredUrl: String
        get() = prefs.getString(KEY_SERVER_URL, "").orEmpty()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.setFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN, WindowManager.LayoutParams.FLAG_FULLSCREEN)
        // 电视端播放期间保持屏幕常亮，避免系统休眠导致画面熄灭。
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        window.requestFeature(Window.FEATURE_NO_TITLE)
        root = FrameLayout(this)
        setContentView(root)

        if (configuredUrl.isBlank()) {
            showSetup()
        } else {
            // 已保存的地址只在启动时自动验证；验证失败就回到选择页面。
            showTvPage(configuredUrl, checkBeforeLoad = true)
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun showTvPage(serverUrl: String, checkBeforeLoad: Boolean) {
        val normalized = normalizeServerUrl(serverUrl) ?: run {
            showSetup("服务器地址无效，请重新选择")
            return
        }
        cancelConnectionWork()
        root.removeAllViews()
        pageLoaded = false
        showConnecting("正在连接 $normalized …")

        val generation = ++setupGeneration
        val open: () -> Unit = open@{
            if (isFinishing || generation != setupGeneration) return@open
            root.removeAllViews()
            pageLoaded = true
            webView = WebView(this).apply {
                setBackgroundColor(Color.rgb(16, 19, 25))
                isFocusable = true
                isFocusableInTouchMode = true
                requestFocus()
                settings.javaScriptEnabled = true
                settings.domStorageEnabled = true
                settings.databaseEnabled = true
                settings.mediaPlaybackRequiresUserGesture = false
                settings.allowFileAccess = true
                settings.allowContentAccess = true
                settings.cacheMode = WebSettings.LOAD_DEFAULT
                settings.userAgentString = settings.userAgentString + " MaidongKtvTV/1.0"
                CookieManager.getInstance().setAcceptCookie(true)
                CookieManager.getInstance().setAcceptThirdPartyCookies(this, true)
                webViewClient = object : WebViewClient() {
                    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean = false

                    override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                        if (request.isForMainFrame) connectionLost("无法连接麦动KTV服务器")
                    }
                }
                webChromeClient = object : WebChromeClient() {
                    override fun onShowCustomView(view: View, callback: CustomViewCallback) {
                        if (fullscreenView != null) {
                            callback.onCustomViewHidden()
                            return
                        }
                        fullscreenView = view
                        fullscreenCallback = callback
                        root.addView(view, FrameLayout.LayoutParams(-1, -1))
                        webView.visibility = View.GONE
                    }

                    override fun onHideCustomView() {
                        hideCustomView()
                    }
                }
            }
            root.addView(webView, FrameLayout.LayoutParams(-1, -1))
            webView.loadUrl("$normalized/tv")
        }

        if (checkBeforeLoad) {
            checkServerAsync(normalized) { ok ->
                if (ok) {
                    prefs.edit().putString(KEY_SERVER_URL, normalized).apply()
                    runOnUiThread { open() }
                } else {
                    runOnUiThread { showSetup("上次服务器无法连接，请重新选择") }
                }
            }
        } else {
            // 手动输入/自动搜索已经通过探测，直接打开主页。
            prefs.edit().putString(KEY_SERVER_URL, normalized).apply()
            open()
        }
    }

    private fun showSetup(message: String? = null) {
        setupGeneration++
        cancelConnectionWork()
        destroyWebView()
        root.removeAllViews()

        val container = FrameLayout(this).apply {
            setBackgroundColor(Color.rgb(16, 19, 25))
            setPadding(dp(90), dp(40), dp(90), dp(40))
        }
        val panel = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(58), dp(40), dp(58), dp(40))
            background = roundedBackground(Color.rgb(32, 27, 42), Color.rgb(255, 92, 122))
        }
        val title = TextView(this).apply {
            text = "麦动KTV TV 点歌客户端"
            textSize = 30f
            setTextColor(Color.WHITE)
            setPadding(0, 0, 0, dp(8))
        }
        val description = TextView(this).apply {
            text = message ?: "请选择连接方式。自动搜索会扫描当前局域网内的麦动KTV服务端（NAS docker）。"
            textSize = 17f
            setTextColor(if (message == null) Color.LTGRAY else Color.rgb(255, 190, 200))
            setPadding(0, 0, 0, dp(20))
        }
        val auto = makeButton("自动搜索局域网", 18f) { startLanScan() }
        val manual = makeButton("手动输入服务器 IP", 18f) { showManualInput(panel, description) }
        panel.addView(title, LinearLayout.LayoutParams(-1, -2))
        panel.addView(description, LinearLayout.LayoutParams(-1, -2))
        panel.addView(auto, LinearLayout.LayoutParams(-1, dp(62)))
        panel.addView(manual, LinearLayout.LayoutParams(-1, dp(62)).apply { topMargin = dp(14) })
        container.addView(panel, FrameLayout.LayoutParams(-1, -2).apply { gravity = android.view.Gravity.CENTER })
        root.addView(container, FrameLayout.LayoutParams(-1, -1))
        auto.requestFocus()
    }

    private fun showManualInput(panel: LinearLayout, description: TextView) {
        panel.removeAllViews()
        val title = TextView(this).apply {
            text = "手动输入服务器 IP"
            textSize = 28f
            setTextColor(Color.WHITE)
            setPadding(0, 0, 0, dp(8))
        }
        description.text = "输入运行 maidong-ktv-server 的地址，例如：192.168.1.100:8080"
        description.setTextColor(Color.LTGRAY)
        val input = EditText(this).apply {
            hint = "192.168.1.100:8080"
            setText(configuredUrl.removePrefix("http://").removePrefix("https://"))
            textSize = 19f
            setSingleLine(true)
            setTextColor(Color.WHITE)
            setHintTextColor(Color.GRAY)
            setPadding(dp(16), 0, dp(16), 0)
            background = roundedBackground(Color.rgb(16, 19, 25), Color.rgb(90, 80, 110))
            isFocusable = true
            isFocusableInTouchMode = true
        }
        val connect = makeButton("连接并打开电视端", 18f) {
            val value = normalizeServerUrl(input.text.toString())
            if (value == null) {
                input.error = "请输入有效的 IP 或 http(s) 地址"
                input.requestFocus()
            } else {
                showTvPage(value, checkBeforeLoad = true)
            }
        }
        val back = makeButton("返回连接方式选择", 15f) { showSetup() }
        panel.addView(title, LinearLayout.LayoutParams(-1, -2))
        panel.addView(description, LinearLayout.LayoutParams(-1, -2))
        panel.addView(input, LinearLayout.LayoutParams(-1, dp(58)))
        panel.addView(connect, LinearLayout.LayoutParams(-1, dp(60)).apply { topMargin = dp(18) })
        panel.addView(back, LinearLayout.LayoutParams(-1, dp(54)).apply { topMargin = dp(8) })
        input.requestFocus()
    }

    private fun startLanScan() {
        val generation = ++setupGeneration
        cancelConnectionWork()
        showConnecting("正在搜索局域网内的麦动KTV服务端…")
        val addresses = localSubnetCandidates()
        if (addresses.isEmpty()) {
            showSetup("无法获取本机局域网地址，请手动输入服务器 IP")
            return
        }
        val executor = Executors.newFixedThreadPool(16)
        connectionExecutor = executor
        val found = AtomicBoolean(false)
        val remaining = java.util.concurrent.atomic.AtomicInteger(addresses.size)
        addresses.forEach { address ->
            executor.execute {
                val candidate = "http://$address:$DEFAULT_PORT"
                if (!found.get() && checkServer(candidate)) {
                    if (found.compareAndSet(false, true)) {
                        executor.shutdownNow()
                        runOnUiThread {
                            if (generation == setupGeneration) showTvPage(candidate, checkBeforeLoad = false)
                        }
                    }
                }
                if (remaining.decrementAndGet() == 0 && found.compareAndSet(false, true)) {
                    runOnUiThread {
                        if (generation == setupGeneration) showSetup("未找到服务端，请确认 NAS 与电视在同一局域网")
                    }
                }
            }
        }
    }

    private fun showConnecting(text: String) {
        root.removeAllViews()
        val label = TextView(this).apply {
            this.text = text
            textSize = 22f
            setTextColor(Color.WHITE)
            gravity = android.view.Gravity.CENTER
        }
        root.addView(label, FrameLayout.LayoutParams(-1, -1))
    }

    private fun checkServerAsync(serverUrl: String, callback: (Boolean) -> Unit) {
        cancelConnectionWork()
        val executor = Executors.newSingleThreadExecutor()
        connectionExecutor = executor
        executor.execute {
            val ok = checkServer(serverUrl)
            runOnUiThread { callback(ok) }
        }
    }

    /** 指纹校验：/api/v1/health 返回 200 且包含 maidong-ktv-server。 */
    private fun checkServer(serverUrl: String): Boolean {
        return runCatching {
            val connection = URL("${serverUrl.trimEnd('/')}/api/v1/health").openConnection() as HttpURLConnection
            connection.connectTimeout = 1200
            connection.readTimeout = 1200
            connection.requestMethod = "GET"
            connection.instanceFollowRedirects = true
            val code = connection.responseCode
            val body = if (code in 200..299) {
                connection.inputStream.bufferedReader().use(BufferedReader::readText)
            } else ""
            connection.disconnect()
            code in 200..299 && body.contains("maidong-ktv-server")
        }.getOrDefault(false)
    }

    private fun localSubnetCandidates(): List<String> {
        val result = linkedSetOf<String>()
        return try {
            val interfaces = Collections.list(NetworkInterface.getNetworkInterfaces())
            interfaces.forEach { networkInterface ->
                if (!networkInterface.isUp || networkInterface.isLoopback) return@forEach
                Collections.list(networkInterface.inetAddresses).forEach { address ->
                    if (address is Inet4Address && !address.isLoopbackAddress) {
                        val parts = address.hostAddress.orEmpty().split('.')
                        if (parts.size == 4) {
                            val prefix = parts.take(3).joinToString(".")
                            for (i in 1..254) result.add("$prefix.$i")
                        }
                    }
                }
            }
            result.toList()
        } catch (_: Throwable) {
            emptyList()
        }
    }

    private fun connectionLost(message: String) {
        if (!pageLoaded || isFinishing) return
        pageLoaded = false
        prefs.edit().remove(KEY_SERVER_URL).apply()
        Toast.makeText(this, message, Toast.LENGTH_LONG).show()
        showSetup("服务器连接失败，请重新选择或输入地址")
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean {
        if (keyCode == KeyEvent.KEYCODE_BACK && fullscreenView != null) {
            hideCustomView()
            return true
        }
        // 主页不显示设置入口；返回键只交给网页返回历史或退出应用。
        if (keyCode == KeyEvent.KEYCODE_BACK && ::webView.isInitialized && webView.canGoBack()) {
            webView.goBack()
            return true
        }
        return super.onKeyDown(keyCode, event)
    }

    private fun makeButton(label: String, size: Float, action: () -> Unit): Button = Button(this).apply {
        text = label
        textSize = size
        setTextColor(Color.WHITE)
        background = roundedBackground(Color.rgb(255, 92, 122), Color.rgb(255, 150, 170))
        isFocusable = true
        setOnClickListener { action() }
    }

    private fun hideCustomView() {
        fullscreenView?.let { root.removeView(it) }
        fullscreenView = null
        fullscreenCallback?.onCustomViewHidden()
        fullscreenCallback = null
        if (::webView.isInitialized) webView.visibility = View.VISIBLE
    }

    private fun destroyWebView() {
        if (::webView.isInitialized) {
            webView.stopLoading()
            webView.destroy()
        }
    }

    private fun cancelConnectionWork() {
        connectionExecutor?.shutdownNow()
        connectionExecutor = null
    }

    override fun onDestroy() {
        cancelConnectionWork()
        hideCustomView()
        destroyWebView()
        super.onDestroy()
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

    private fun roundedBackground(fill: Int, stroke: Int): GradientDrawable = GradientDrawable().apply {
        setColor(fill)
        cornerRadius = dp(10).toFloat()
        setStroke(dp(1), stroke)
    }

    private fun normalizeServerUrl(raw: String): String? {
        var trimmed = raw.trim().removeSuffix("/")
        if (trimmed.isBlank()) return null
        if (!trimmed.startsWith("http://", true) && !trimmed.startsWith("https://", true)) {
            trimmed = "http://$trimmed"
        }
        val uri = runCatching { Uri.parse(trimmed) }.getOrNull() ?: return null
        if (uri.scheme !in listOf("http", "https") || uri.host.isNullOrBlank()) return null
        return trimmed
    }

    companion object {
        private const val PREFS = "maidong_ktv_tv"
        private const val KEY_SERVER_URL = "server_url"
        private const val DEFAULT_PORT = 8080
    }
}
