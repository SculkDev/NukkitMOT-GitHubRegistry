package com.memoriesoftime.agent;

import java.io.IOException;
import java.net.Proxy;
import java.net.ProxySelector;
import java.net.SocketAddress;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpHeaders;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.List;
import java.util.Optional;
import java.util.concurrent.atomic.AtomicReference;

/** Runs in a separate JVM, with or without the packaged agent. */
public final class AgentProbe {
    private static final String FROM = "https://bin-data.nkmot.com/";
    private static final String TO = "https://raw.githubusercontent.com/MemoriesOfTime/Bin_Data/main/";
    private static final AtomicReference<URI> SELECTED = new AtomicReference<>();
    private static final HttpClient CLIENT = HttpClient.newBuilder().proxy(new ProxySelector() {
        @Override
        public List<Proxy> select(URI uri) {
            SELECTED.set(uri);
            // Stop before DNS, TCP, or TLS. The client's internal request has
            // already been constructed when this callback receives its URI.
            throw new ProbeStop();
        }

        @Override
        public void connectFailed(URI uri, SocketAddress address, IOException failure) {
            throw new AssertionError("Unexpected network access", failure);
        }
    }).build();

    public static void main(String[] arguments) throws Exception {
        boolean active = Boolean.parseBoolean(arguments[0]);
        String[] urls = {
            FROM, FROM + "palettes.json", FROM + "palettes.zip",
            FROM + "nested/palette%20one.nbt?version=1&name=%2F#part",
            FROM + "a/../palette.nbt", FROM + "?query=1", TO + "palettes.json",
            "https://example.org/", "http://bin-data.nkmot.com/palettes.json",
            "https://bin-data.nkmot.com.evil.example/palettes.json",
            "https://bin-data.nkmot.com@evil.example/palettes.json",
            "https://example.org/?url=" + FROM,
            "https://bin-data.nkmot.com", "https://bin-data.nkmot.com:443/palettes.json"
        };
        for (String url : urls) {
            HttpRequest request = HttpRequest.newBuilder(URI.create(url)).GET().build();
            // Current OpenJDKs build an ImmutableHttpRequest; HttpRequestImpl
            // is the internal copy made on send, which is what we instrument.
            checkSend(request, expected(url, active), 0);
            HttpRequest copied = HttpRequest.newBuilder().uri(URI.create(url)).copy().GET().build();
            checkSend(copied, expected(url, active), 1);
        }

        HttpRequest.BodyPublisher body = HttpRequest.BodyPublishers.ofString("test body");
        HttpRequest configured = HttpRequest.newBuilder(URI.create(FROM + "palettes.json"))
                .timeout(Duration.ofSeconds(60)).header("User-Agent", "Nukkit-MOT/test")
                .header("X-Probe", "preserved").version(HttpClient.Version.HTTP_1_1)
                .expectContinue(true).POST(body).build();
        equal("POST", configured.method());
        equal("Nukkit-MOT/test", configured.headers().firstValue("User-Agent").orElseThrow());
        equal("preserved", configured.headers().firstValue("X-Probe").orElseThrow());
        equal(Optional.of(Duration.ofSeconds(60)), configured.timeout());
        equal(Optional.of(HttpClient.Version.HTTP_1_1), configured.version());
        equal(true, configured.expectContinue());
        equal(body, configured.bodyPublisher().orElseThrow());

        // Custom HttpRequests bypass the builder and must still be rewritten on send.
        for (String url : new String[] {FROM + "palettes.json?name=%2F", "https://example.org/file"}) {
            HttpRequest custom = customRequest(url, configured);
            for (int mode = 0; mode < 3; mode++) {
                checkSend(custom, expected(url, active), mode);
            }
        }
        for (int mode = 0; mode < 3; mode++) {
            checkSend(configured, expected(FROM + "palettes.json", active), mode);
        }
        if (System.getProperty("probe.preloaded") != null) {
            // This immutable request was built before our agent was installed.
            equal(FROM + "preloaded.nbt", PreloadAgent.request.uri().toString());
            for (int mode = 0; mode < 3; mode++) {
                checkSend(PreloadAgent.request, TO + "preloaded.nbt", mode);
            }
        }
        System.out.println("PASS: active=" + active + "; request properties and sync/async destinations verified");
    }

    private static String expected(String url, boolean active) {
        return active && url.startsWith(FROM) ? TO + url.substring(FROM.length()) : url;
    }

    private static void checkSend(HttpRequest request, String expectedUri, int mode) throws Exception {
        SELECTED.set(null);
        try {
            if (mode == 0) {
                CLIENT.send(request, HttpResponse.BodyHandlers.discarding());
            } else if (mode == 1) {
                CLIENT.sendAsync(request, HttpResponse.BodyHandlers.discarding()).join();
            } else {
                CLIENT.sendAsync(request, HttpResponse.BodyHandlers.discarding(),
                        (initial, push, acceptor) -> { }).join();
            }
            throw new AssertionError("Expected the probe to stop before network access");
        } catch (Exception stopped) {
            Throwable cause = stopped;
            while (cause.getCause() != null) {
                cause = cause.getCause();
            }
            if (!(cause instanceof ProbeStop)) {
                throw new AssertionError("Unexpected send failure", stopped);
            }
        }
        equal(URI.create(expectedUri), SELECTED.get());
    }

    private static HttpRequest customRequest(String url, HttpRequest delegate) {
        return new HttpRequest() {
            @Override public URI uri() { return URI.create(url); }
            @Override public String method() { return delegate.method(); }
            @Override public HttpHeaders headers() { return delegate.headers(); }
            @Override public Optional<BodyPublisher> bodyPublisher() { return delegate.bodyPublisher(); }
            @Override public Optional<Duration> timeout() { return delegate.timeout(); }
            @Override public boolean expectContinue() { return delegate.expectContinue(); }
            @Override public Optional<HttpClient.Version> version() { return delegate.version(); }
        };
    }

    private static void equal(Object expected, Object actual) {
        if (!expected.equals(actual)) {
            throw new AssertionError("Expected <" + expected + ">, got <" + actual + ">");
        }
    }

    private static final class ProbeStop extends RuntimeException {
        private static final long serialVersionUID = 1L;
    }
}
