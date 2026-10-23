using System.Text.Json.Nodes;
using Microsoft.Extensions.Configuration;
using Microsoft.Identity.Client;
using PreDraftReport.Console.QuickStart.Authentication;
using Xunit;

namespace PreDraftReport.Console.QuickStart.Tests;

/// <summary>
/// Covers a run of the console against the simulated endpoint, including the settings, manifest and
/// payload that ship with the sample.
/// </summary>
public sealed class ProgramTests : IDisposable
{
    private readonly string _directory = Directory.CreateTempSubdirectory("pre-draft-report-console").FullName;
    private readonly StringWriter _output = new();

    private static string BundledPayload =>
        Path.Combine(AppContext.BaseDirectory, "MockData", "pre-draft-report-ingest-request.json");

    private string Output => _output.ToString();

    public void Dispose()
    {
        _output.Dispose();
        Directory.Delete(_directory, recursive: true);
    }

    [Fact]
    public async Task TheShippedSettingsStoreTheBundledPayload()
    {
        var exitCode = await RunAsync(ShippedSettings(), BundledPayload);

        Assert.Equal(0, exitCode);
        Assert.Contains("Installed:       sampleRadiologyExtension", Output, StringComparison.Ordinal);
        Assert.Contains("200 OK", Output, StringComparison.Ordinal);
    }

    [Fact]
    public async Task ASecondRunReportsTheResultAsAlreadyStoredAndSucceeds()
    {
        var settings = ShippedSettings();
        await RunAsync(settings, BundledPayload);

        var exitCode = await RunAsync(settings, BundledPayload);

        Assert.Equal(0, exitCode);
        Assert.Contains("409 Conflict, reason ResultAlreadyStored", Output, StringComparison.Ordinal);
    }

    [Fact]
    public async Task AnUnknownAccessionNumberFailsWithAHint()
    {
        var bundled = await File.ReadAllTextAsync(BundledPayload);
        var payload = WritePayload(bundled.Replace("ACC-0000001", "ACC-DOES-NOT-EXIST", StringComparison.Ordinal));

        var exitCode = await RunAsync(ShippedSettings(), payload);

        Assert.Equal(1, exitCode);
        Assert.Contains("404 NotFound, reason OrderNotFound", Output, StringComparison.Ordinal);
        Assert.Contains("No order in the environment has the accession number", Output, StringComparison.Ordinal);
    }

    [Fact]
    public async Task AMissingManifestIsReportedAndTheSubmissionGetsExtensionNotFound()
    {
        var settings = ShippedSettings();
        settings.Simulation.Installations[0].ManifestPath = Path.Combine(_directory, "missing.yaml");

        var exitCode = await RunAsync(settings, BundledPayload);

        Assert.Equal(1, exitCode);
        Assert.Contains("Not installed:", Output, StringComparison.Ordinal);
        Assert.Contains("404 NotFound, reason ExtensionNotFound", Output, StringComparison.Ordinal);
    }

    [Fact]
    public async Task WithATokenProviderTheTokenIsSentAndAccepted()
    {
        var exitCode = await RunAsync(ShippedSettings(), BundledPayload, new FakeTokenProvider());

        Assert.Equal(0, exitCode);
        Assert.Contains("Acquired an access token", Output, StringComparison.Ordinal);
        Assert.Contains("200 OK", Output, StringComparison.Ordinal);
    }

    [Fact]
    public async Task AMissingPayloadFails()
    {
        var exitCode = await RunAsync(ShippedSettings(), Path.Combine(_directory, "missing.json"));

        Assert.Equal(1, exitCode);
        Assert.Contains("Payload not found", Output, StringComparison.Ordinal);
    }

    [Fact]
    public async Task APayloadThatIsNotJsonFails()
    {
        var exitCode = await RunAsync(ShippedSettings(), WritePayload("{ not json"));

        Assert.Equal(1, exitCode);
        Assert.Contains("Payload is not a valid draft report ingest request", Output, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("aiGenerated")]
    [InlineData("aiConfidence")]
    [InlineData("sectionOrder")]
    public async Task APayloadMissingARequiredSectionValueFailsInsteadOfSendingADefault(string property)
    {
        var payload = await BundledPayloadAsync();
        payload["draftReport"]!["reportContent"]!["structuredReport"]!["sections"]![0]!.AsObject().Remove(property);

        var exitCode = await RunAsync(ShippedSettings(), WritePayload(payload.ToJsonString()));

        Assert.Equal(1, exitCode);
        Assert.Contains("Payload is not a valid draft report ingest request", Output, StringComparison.Ordinal);
        Assert.Contains($"'{property}'", Output, StringComparison.Ordinal);
        Assert.DoesNotContain("Submitting", Output, StringComparison.Ordinal);
    }

    [Fact]
    public async Task APayloadMissingTheImageQualityScoreFailsInsteadOfSendingADefault()
    {
        var payload = await BundledPayloadAsync();
        payload["draftReport"]!["qualityMetrics"]!.AsObject().Remove("imageQualityScore");

        var exitCode = await RunAsync(ShippedSettings(), WritePayload(payload.ToJsonString()));

        Assert.Equal(1, exitCode);
        Assert.Contains("'imageQualityScore'", Output, StringComparison.Ordinal);
        Assert.DoesNotContain("Submitting", Output, StringComparison.Ordinal);
    }

    [Fact]
    public async Task APayloadWithoutADraftReportIsSubmittedAndRejectedByTheEndpoint()
    {
        var payload = await BundledPayloadAsync();
        payload.Remove("draftReport");

        var exitCode = await RunAsync(ShippedSettings(), WritePayload(payload.ToJsonString()));

        Assert.Equal(1, exitCode);
        Assert.Contains("400 BadRequest", Output, StringComparison.Ordinal);
        Assert.Contains("The DraftReport field is required.", Output, StringComparison.Ordinal);
    }

    [Fact]
    public async Task AnEnvironmentThatCannotBeSetUpFails()
    {
        var settings = ShippedSettings();
        settings.Simulation.StoredResultsPath = "stored\0results.txt";

        var exitCode = await RunAsync(settings, BundledPayload);

        Assert.Equal(1, exitCode);
        Assert.Contains("Could not set up the simulated environment", Output, StringComparison.Ordinal);
    }

    [Fact]
    public async Task ATokenThatCannotBeAcquiredFails()
    {
        var exitCode = await RunAsync(ShippedSettings(), BundledPayload, new FailingTokenProvider());

        Assert.Equal(1, exitCode);
        Assert.Contains("Could not acquire an access token. invalid_client: The client secret is not valid.", Output, StringComparison.Ordinal);
        Assert.DoesNotContain("Submitting", Output, StringComparison.Ordinal);
    }

    [Fact]
    public async Task ARequestThatFailsIsReported()
    {
        var exitCode = await RunWithHandlerAsync(
            ShippedSettings(),
            _ => throw new HttpRequestException("No such host is known."),
            CancellationToken.None);

        Assert.Equal(1, exitCode);
        Assert.Contains("The request failed: No such host is known.", Output, StringComparison.Ordinal);
    }

    [Fact]
    public async Task ARequestWithNoResponseTimesOut()
    {
        var settings = ShippedSettings();
        settings.DragonCopilot.TimeoutSeconds = 1;

        var exitCode = await RunWithHandlerAsync(settings, NeverRespondAsync, CancellationToken.None);

        Assert.Equal(1, exitCode);
        Assert.Contains("No response within 1 seconds.", Output, StringComparison.Ordinal);
    }

    [Fact]
    public async Task ARunCancelledBeforeItStartsReportsCancelled()
    {
        using var cancellation = new CancellationTokenSource();
        await cancellation.CancelAsync();

        var exitCode = await Program.RunAsync(ShippedSettings(), BundledPayload, AppContext.BaseDirectory, _output, null, cancellation.Token);

        Assert.Equal(1, exitCode);
        Assert.Contains("Cancelled.", Output, StringComparison.Ordinal);
    }

    [Fact]
    public async Task ARunCancelledWhileWaitingForAResponseReportsCancelled()
    {
        using var cancellation = new CancellationTokenSource();
        var exitCode = await RunWithHandlerAsync(
            ShippedSettings(),
            async cancellationToken =>
            {
                await cancellation.CancelAsync();
                return await NeverRespondAsync(cancellationToken);
            },
            cancellation.Token);

        Assert.Equal(1, exitCode);
        Assert.Contains("Cancelled.", Output, StringComparison.Ordinal);
        Assert.DoesNotContain("No response within", Output, StringComparison.Ordinal);
    }

    [Fact]
    public async Task MainThrowsWhenArgsIsNull()
    {
        await Assert.ThrowsAsync<ArgumentNullException>(() => Program.Main(null!));
    }

    private SampleSettings ShippedSettings()
    {
        // The appsettings.json that ships with the sample, keeping stored results in this test's folder.
        var configuration = new ConfigurationBuilder()
            .SetBasePath(AppContext.BaseDirectory)
            .AddJsonFile("appsettings.json", optional: false)
            .Build();

        var settings = SampleSettings.Load(configuration);
        settings.Simulation.StoredResultsPath = Path.Combine(_directory, "stored-results.txt");
        return settings;
    }

    private string WritePayload(string json)
    {
        var path = Path.Combine(_directory, $"{Guid.NewGuid()}.json");
        File.WriteAllText(path, json);
        return path;
    }

    private Task<int> RunAsync(SampleSettings settings, string payloadPath, ITokenProvider? tokenProvider = null) =>
        Program.RunAsync(settings, payloadPath, AppContext.BaseDirectory, _output, tokenProvider, CancellationToken.None);

    private Task<int> RunWithHandlerAsync(
        SampleSettings settings,
        Func<CancellationToken, Task<HttpResponseMessage>> respond,
        CancellationToken cancellationToken) =>
        Program.RunAsync(
            settings,
            BundledPayload,
            AppContext.BaseDirectory,
            _output,
            tokenProvider: null,
            _ => new StubHandler(respond),
            cancellationToken);

    private static async Task<JsonObject> BundledPayloadAsync() =>
        JsonNode.Parse(await File.ReadAllTextAsync(BundledPayload))!.AsObject();

    private static async Task<HttpResponseMessage> NeverRespondAsync(CancellationToken cancellationToken)
    {
        await Task.Delay(Timeout.Infinite, cancellationToken);
        return new HttpResponseMessage();
    }

    private sealed class FakeTokenProvider : ITokenProvider
    {
        public Task<string> GetAccessTokenAsync(CancellationToken cancellationToken) => Task.FromResult("test-token");
    }

    private sealed class FailingTokenProvider : ITokenProvider
    {
        public Task<string> GetAccessTokenAsync(CancellationToken cancellationToken) =>
            throw new MsalServiceException("invalid_client", "The client secret is not valid.");
    }

    private sealed class StubHandler(Func<CancellationToken, Task<HttpResponseMessage>> respond) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken) =>
            respond(cancellationToken);
    }
}
