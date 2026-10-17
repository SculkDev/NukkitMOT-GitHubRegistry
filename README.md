# Nukkit-MOT mirror redirect agent

Redirects this exact, case-sensitive URL prefix in the JDK `java.net.http.HttpClient`:

```text
https://bin-data.nkmot.com/
    -> https://raw.githubusercontent.com/MemoriesOfTime/Bin_Data/main/
```

For example, `https://bin-data.nkmot.com/palettes.json` becomes
`https://raw.githubusercontent.com/MemoriesOfTime/Bin_Data/main/palettes.json`.
Paths, percent encoding, queries, and fragments are preserved. Other URLs are unchanged.

## Docker container

The derived image uses [`memoriesoftime/nukkit-mot`](https://hub.docker.com/r/memoriesoftime/nukkit-mot)
and preloads the agent. It keeps upstream's non-root user, entrypoint,
`JAVA_OPTS`, `/data` volume and network ports.

```sh
docker run -d --name nukkit-mot \
  -p 19132:19132/udp -p 19132:19132/tcp \
  -v nukkit-data:/data \
  -e JAVA_OPTS="-Xms1G -Xmx2G" \
  --restart unless-stopped \
  ghcr.io/sculkdev/nukkitmot-githubregistry:latest
```

Alternatively, use the included `compose.yaml`:

```sh
docker compose up -d
```

The agent is injected with `JAVA_TOOL_OPTIONS`. If you override that variable,
include `-javaagent:/opt/nukkit-agent.jar` in its value.
Use `JAVA_OPTS` for memory settings as shown above.

To build locally (Docker builds and tests the agent too):

```sh
docker build -t nukkit-mot-patched .
```

Local builds default to upstream `:latest`. To select a stable upstream tag:

```sh
docker build --build-arg UPSTREAM_IMAGE=memoriesoftime/nukkit-mot:1.26.50-R1 -t nukkit-mot-patched .
```

## Automatic releases and GHCR publishing

The [`Publish patched Nukkit-MOT`](.github/workflows/publish.yml) workflow runs
on pushes to `main`, manually from the Actions tab, and hourly at minute 23 UTC.
No personal access token or Docker Hub credentials are required: it publishes
with the repository's built-in `GITHUB_TOKEN`.

1. Discover the newest stable Docker Hub tag, comparing version numbers
   numerically and excluding `-java25` variants. Upstream publishes stable
   Docker tags from Git tags; it currently does not create GitHub Releases.
2. Wait until both `linux/amd64` and `linux/arm64` images are available, then
   pin the base image to its exact digest.
3. Skip builds already completed for that upstream digest and this repository
   commit. A new upstream release, a rebuilt base image, or an agent update
   triggers a new build.
4. Build and test the agent, then run the HTTP rewrite checks inside the actual
   upstream runtime on both architectures. Publish only after those checks pass.
5. Push the multi-architecture image to GHCR and create a GitHub Release with
   the standalone agent, its SHA-256 checksum, and image metadata. Failed asset
   uploads leave a draft that the next run retries.

Image tags in this repository:

| Tag | Meaning |
| --- | --- |
| `latest` | Most recently built stable upstream release |
| `1.26.50-R1` (example) | Newest patched build for that upstream version |
| `1.26.50-R1-base-<digest12>-agent-<commit12>` | Specific base image and agent revision |

`latest` here follows **stable releases** by default. Upstream's `latest` is a
development snapshot. To follow snapshots instead, set the repository Actions
variable `UPSTREAM_TAG` to `latest`. You can also set it to a specific Docker
Hub tag. Leaving it unset, or setting it to `stable`, tracks stable releases.

For initial setup, keep the workflow on the repository's default branch (`main`)
and allow Actions to run. The first push publishes the current stable version;
later polls do nothing until the base digest or repository commit changes.
GHCR packages initially default to private, even for public repositories; make
the package public once in its package settings for anonymous pulls, or use
`docker login ghcr.io` with an account that can read it.

GitHub can delay scheduled jobs and can disable schedules in public repositories
after 60 days without repository activity. Check the Actions tab if polling
stops. See [GitHub's schedule documentation](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule).

## Run

Copy `target/nukkit-mot-javaagent.jar` alongside your Nukkit server JAR, then start:

```sh
java -javaagent:nukkit-mot-javaagent.jar -jar nukkit.jar
```

Use your actual server JAR filename and keep your existing JVM options before `-jar`.
For paths containing spaces, quote the entire agent argument:

```sh
java "-javaagent:C:/My Server/nukkit-mot-javaagent.jar" -jar nukkit.jar
```

At startup, the agent prints:

```text
[nukkit-mot-javaagent] Active: https://bin-data.nkmot.com/ -> https://raw.githubusercontent.com/MemoriesOfTime/Bin_Data/main/
```

This is a startup agent, not a Nukkit plugin. It takes no arguments and requires
no `--add-opens`, `--add-exports`, or separate dependency JARs. Nukkit's existing
SHA-256 and size verification continues to work normally.

## Build and test

Requires a JDK 11+ and Maven 3.6.3+:

```sh
mvn verify
```

The standalone agent is `target/nukkit-mot-javaagent.jar`. ASM is bundled under a
private package to avoid conflicts with the server's dependencies. Integration
tests start separate JVMs with the actual packaged JAR and full bytecode
verification. They check prefix matching, request settings, all three
`send`/`sendAsync` overloads, custom requests, and requests created by an earlier
agent. They stop at proxy selection, so they need no internet access.

To run the test JVM on another Java installation:

```sh
mvn verify "-Dagent.test.java=C:/path/to/jdk/bin/java.exe"
```

## Implementation and compatibility

The agent retransforms `jdk.internal.net.http.HttpRequestImpl`, the internal
request used by OpenJDK's HTTP client. It rewrites URI assignments in its
constructors, covering requests built normally and requests copied internally
when sending. It injects only standard `URI` and `String` calls into the JDK;
no agent helpers are loaded into the platform or bootstrap class loaders.

This depends on OpenJDK internals and is intended for OpenJDK-based Java 11–25
(including Temurin); the packaged agent has been tested on Java 17, 21, and 25.
A JVM with different internals or no retransformation
support is unsupported; the agent fails startup if its initial patch cannot
be installed. It does not intercept `HttpURLConnection`, third-party HTTP
clients, or custom `HttpClient` implementations. The rewrite applies to all
matching JDK HTTP client requests in the JVM.
