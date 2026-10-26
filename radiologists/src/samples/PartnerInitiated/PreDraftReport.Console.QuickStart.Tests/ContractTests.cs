using System.Text.Json;
using System.Text.Json.Nodes;
using Dragon.Copilot.Radiologists.Models;
using PreDraftReport.Console.QuickStart.Simulation;
using Xunit;

namespace PreDraftReport.Console.QuickStart.Tests;

/// <summary>
/// Ties the request bodies that ship with the sample to the published contract, so that the console,
/// the simulator and the schema can't drift apart.
/// </summary>
public sealed class ContractTests
{
    private const string TenantId = "11111111-1111-1111-1111-111111111111";
    private const string EnvironmentId = "22222222-2222-2222-2222-222222222222";
    private const string BundledPayloadName = "MockData/pre-draft-report-ingest-request.json";
    private const string HttpFileName = "submit-pre-draft-report.http";

    private static readonly string[] RequestLinePrefixes = ["GET ", "POST ", "PUT ", "PATCH ", "DELETE "];

    /// <summary>
    /// Gets every request body that ships with the sample: the bundled payload, and the body of each
    /// request in the .http file. The .http requests that expect an error expect a 404 or 409 from a
    /// lookup, so their bodies are valid too.
    /// </summary>
    public static TheoryData<string, string> RequestBodies
    {
        get
        {
            var bodies = new TheoryData<string, string>
            {
                { BundledPayloadName, File.ReadAllText(OutputPath(BundledPayloadName)) },
            };

            foreach (var (title, body) in ReadHttpRequests())
            {
                bodies.Add($"{HttpFileName}: {title}", body);
            }

            return bodies;
        }
    }

    [Fact]
    public void TheBundledPayloadIsThePublishedExample()
    {
        // The published example is validated against the request schema, so this ties the bundled payload to the schema.
        var bundled = JsonNode.Parse(File.ReadAllText(OutputPath(BundledPayloadName)));
        var published = JsonNode.Parse(File.ReadAllText(OutputPath("Contract/PreDraftReportGeneration-Ingest-Request-Example.json")));

        Assert.True(
            JsonNode.DeepEquals(bundled, published),
            "MockData/pre-draft-report-ingest-request.json must stay a copy of radiologists/partner-initiated/samples/PreDraftReportGeneration-Ingest-Request-Example.json.");
    }

    [Fact]
    public void TheHttpFileHasABodyForEveryRequest()
    {
        var requests = ReadHttpRequests();

        Assert.NotEmpty(requests);
        Assert.All(requests, request => Assert.False(string.IsNullOrWhiteSpace(request.Body), $"'{request.Title}' has no body."));
    }

    [Theory]
    [MemberData(nameof(RequestBodies))]
    public void AShippedRequestBodyPassesTheSimulatorsValidation(string source, string body)
    {
        var validation = SimulatedRequestValidator.Validate(TenantId, EnvironmentId, body);

        var errors = string.Join("; ", validation.Errors.Select(error => $"{error.Key}: {string.Join(" ", error.Value)}"));
        Assert.True(validation.IsValid, $"{source} fails validation: {errors}");
    }

    [Theory]
    [MemberData(nameof(RequestBodies))]
    public void AShippedRequestBodyIsReadByTheConsole(string source, string body)
    {
        var request = JsonSerializer.Deserialize<DraftReportIngestRequest>(body, Program.PayloadSerializerOptions);

        Assert.True(request?.DraftReport is not null, $"{source} has no draft report.");
    }

    private static string OutputPath(string relativePath) =>
        Path.Combine(AppContext.BaseDirectory, relativePath.Replace('/', Path.DirectorySeparatorChar));

    // Each request starts with a "###" line; the lines before the first are variables. A request's body
    // follows the first blank line after its request line, as in the REST Client .http format.
    private static List<(string Title, string Body)> ReadHttpRequests()
    {
        var text = "\n" + File.ReadAllText(OutputPath($"Contract/{HttpFileName}")).ReplaceLineEndings("\n");
        var requests = new List<(string Title, string Body)>();
        foreach (var block in text.Split("\n###").Skip(1))
        {
            var lines = block.Split('\n');
            var title = lines[0].Trim();
            var requestLine = Array.FindIndex(lines, line => RequestLinePrefixes.Any(prefix => line.StartsWith(prefix, StringComparison.Ordinal)));
            if (requestLine < 0)
            {
                throw new InvalidOperationException($"'{title}' in {HttpFileName} has no request line.");
            }

            var blankLine = Array.FindIndex(lines, requestLine, string.IsNullOrWhiteSpace);
            var body = blankLine < 0 ? string.Empty : string.Join('\n', lines[(blankLine + 1)..]).Trim();
            requests.Add((title, body));
        }

        return requests;
    }
}
