// **********************************************************************************
// ************************* FOR LOCAL USE ******************************************
// process.env.ENDPOINT_AUTH_PARAMETER_SYSTEMVSSCONNECTION_ACCESSTOKEN=""
// process.env.SYSTEM_TEAMPROJECT = ""
// process.env.INPUT_ORGANIZATION = ""
// process.env.INPUT_SCREENSHOTFOLDER = ""
// process.env.BUILD_BUILDID = ""
// **********************************************************************************

import * as tl from "azure-pipelines-task-lib/task"
import * as azdev from "azure-devops-node-api";
import * as ta from "azure-devops-node-api/TestApi";
import * as fs from "fs";
import { TestOutcome, ShallowTestCaseResult, TestAttachmentRequestModel, TestAttachmentReference } from 'azure-devops-node-api/interfaces/TestInterfaces';

const DEFAULT_SCREENSHOT_FOLDER = "./app/build/reports/androidTests/connected/screenshots/failures/";
const PARAM_SCREENSHOT_FOLDER = "screenshotFolder";
const PARAM_ORGANIZATION = "organization";

let project = tl.getVariable("System.TeamProject");
let testApi: ta.ITestApi
let buildId = tl.getVariable("Build.BuildId");

async function run() {
    try {
        let authToken = tl.getEndpointAuthorizationParameter('SystemVssConnection', 'AccessToken', false);
        if (!authToken) {
          tl.setResult(tl.TaskResult.Failed, "Could not get access token. Please check the endpoint configuration.", true);
          return;
        }

        if (!project) {
          tl.setResult(tl.TaskResult.Failed, "Could not get project name. Please check the endpoint configuration.", true);
          return;
        }

        if (!buildId) {
          tl.setResult(tl.TaskResult.Failed, "Could not get build id. Please check the endpoint configuration.", true);
          return;
        }

        let authHandler = azdev.getPersonalAccessTokenHandler(authToken);
        let connection = new azdev.WebApi("https://dev.azure.com/" + getOrganization(), authHandler);
        testApi = await connection.getTestApi();
        await testApi.getTestResultsByBuild(project, +buildId, undefined, [TestOutcome.Failed])
            .then(async failedTests =>  uploadScreenshots(failedTests))
            .catch(err => tl.setResult(tl.TaskResult.Failed, err.message))
    }
    catch (err) {
        tl.setResult(tl.TaskResult.Failed, (err as Error).message);
    }
}

run();

async function uploadScreenshots(failedTests: ShallowTestCaseResult[]) {
    let apiCalls: Promise<any>[] = [];
    let missingScreenshots: Error[] = [];
    let totalFailures = failedTests.length

    if(totalFailures <= 0) {
        tl.setResult(tl.TaskResult.Skipped, "No test failures found.")
        return
    }
    console.log(totalFailures + " tests failed. Will proceed with screenshot upload.")
    failedTests.forEach(async (failedTest: ShallowTestCaseResult, index) => {
        let testName = failedTest.automatedTestName;
        let className = failedTest.automatedTestStorage;
        let imgPath = getScreenshotFolder() + className + "/" + testName + ".png";//TODO make it configurable in upcoming version
        tl.debug("Searching for image at path: " + imgPath);
        if (fs.existsSync(imgPath)) {
            let imageAsBase64 = fs.readFileSync(imgPath, 'base64');
            let attachment: TestAttachmentRequestModel = {fileName: testName + ".png", stream: imageAsBase64};

            apiCalls.push(testApi.createTestResultAttachment(attachment, project!, failedTest.runId!, failedTest.id!));
        } else {
            tl.debug("Failure - No screenshot found for " + className + "/" + testName);
            missingScreenshots.push(Error("No screenshot found for " + className + "/" + testName));
        }
    });
    Promise.all(apiCalls).then(function(attachmentResults) {
        let attachmentFailedCount = attachmentResults.filter(attachmentResult => attachmentResult == null).length
        let hasMissingScreenshot = missingScreenshots.length > 0
        let hasAttachmentFailure = attachmentFailedCount > 0

        tl.debug("hasMissingScreenshot: " + hasMissingScreenshot + " -- hasAttachmentFailure: " + hasAttachmentFailure)
        if (hasMissingScreenshot || hasAttachmentFailure) {
            let message = ""
            if (hasMissingScreenshot) message += (totalFailures != missingScreenshots.length ? "Some screenshots were missing. " : "All screenshots were missing. ");
            if (hasAttachmentFailure) message += (totalFailures != attachmentFailedCount) ? "Some attachments failed. " : "All attachments failed. "

            tl.setResult(tl.TaskResult.SucceededWithIssues, message);
        } else {
            attachmentResults.forEach(attachmentResult => tl.debug("attachment success-> " + (attachmentResult as TestAttachmentReference).url))
            tl.setResult(tl.TaskResult.Succeeded, "All screenshots were published successfully");
        }
        console.log("Task completed. Published " + (attachmentResults.length - attachmentFailedCount) + "/" + totalFailures + " screenshots")
    })
}

/**
 * Get the input parameter "screenshotFolder"
 *
 * @returns the value from the input param or DEFAULT_SCREENSHOT_FOLDER
 */
function getScreenshotFolder(): string {
    let screenshotFolder = tl.getInput(PARAM_SCREENSHOT_FOLDER)
    if (!screenshotFolder) {
        return DEFAULT_SCREENSHOT_FOLDER
    } else {
        return screenshotFolder += screenshotFolder.endsWith("/") ? "" : "/"
    }
}

/**
 * Get the input parameter "organization" in order to make REST calls
 *
 * **NOTE**: this is needed until a System.OrganizationName is exposed (*see: https://developercommunity.visualstudio.com/idea/747962/add-a-variable-to-access-organization-name.html*)
 *
 * @returns the organization
 * @throws an error if no value was given
 */
function getOrganization(): string {
    let organization = tl.getInput(PARAM_ORGANIZATION)
    if (!organization) {
        throw Error("Organization is mandatory")
    } else {
        return organization
    }
}

