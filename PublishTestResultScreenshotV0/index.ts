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
import fs from "fs";
import { TestOutcome, TestAttachmentRequestModel, TestAttachmentReference, TestRun, TestCaseResult, ResultDetails } from 'azure-devops-node-api/interfaces/TestInterfaces';
import filenamify = require('filenamify');

const DEFAULT_SCREENSHOT_FOLDER = "./app/build/reports/androidTests/connected/screenshots/failures/";
const PARAM_SCREENSHOT_FOLDER = "screenshotFolder";
const PARAM_ORGANIZATION = "organization";

let project = tl.getVariable("System.TeamProject");
let testApi: ta.ITestApi

async function run() {
    try {
        let authToken = tl.getEndpointAuthorizationParameter('SystemVssConnection', 'AccessToken', false);
        let authHandler = azdev.getPersonalAccessTokenHandler(authToken);
        let connection = new azdev.WebApi("https://dev.azure.com/" + getOrganization(), authHandler);
        testApi = await connection.getTestApi();

        let system = tl.getVariable("SYSTEM");
        
        try {
            let testRunId = await getTestRunIdBy(system);
            let results = await getFailureResultsBy(testRunId);
            await uploadScreenshots(results);
        }catch(err){ 
            tl.setResult(tl.TaskResult.Failed, err.message); 
        }
    }
    catch (err) {
        tl.setResult(tl.TaskResult.Failed, err.message);
    }
}

run();

/**
 * Given system [build or release] returning the Id of the latest TestRun 
 * @param system 
 * @returns Latest TestRun Id
 */
async function getTestRunIdBy(system : string): Promise<number> {
    let ret :number = -1;
    let testRuns : TestRun[] = [];
    let today = new Date();
    let yesterday = new Date();
    yesterday.setDate(today.getDate() -1);

    let buildid = tl.getVariable("BUILD_BUILDID");
    switch(system) {
        case "build":
            testRuns = await testApi.queryTestRuns(project, yesterday, today, undefined, undefined, undefined, undefined, [+buildid], undefined, undefined, undefined, undefined, undefined, undefined,undefined, undefined,undefined );
            break;
        case "release":
            let releaseId = tl.getVariable("RELEASE_RELEASEID");
            let releaseEnvId = tl.getVariable("RELEASE_ENVIRONMENTID");
            testRuns = await testApi.queryTestRuns(project, yesterday, today, undefined, undefined, undefined, undefined, [+buildid], undefined, undefined, [+releaseId], undefined, [+releaseEnvId], undefined,undefined, undefined,undefined );
            break;
        default:
            tl.debug(`unsupported system value: ${system}`);
    }

    if (testRuns.length === 1){
        ret = testRuns[0].id;
    }
    else if (testRuns.length > 1) {
        // when query return more than 1 Run, sort desc and pick the first.
        ret = testRuns.map( run=> run.id).sort((a,b)=> b-a)[0]; 
    }

    return ret;
}

/**
 * Give a runId return an array of TestCaseResult which TestOutcome is failed
 * @param runId 
 * @returns an array of TestCaseResult
 */
async function getFailureResultsBy(runId: number) :  Promise<TestCaseResult[]>{
    let ret : TestCaseResult[] = [];
    ret = await testApi.getTestResults(project, runId, ResultDetails.None, undefined, undefined,[TestOutcome.Failed] );
    return ret;
}


async function uploadScreenshots(failedTests: TestCaseResult[]) {
    let apiCalls: Promise<any>[] = [];
    let missingScreenshots: Error[] = [];
    let totalFailures = failedTests.length

    if(totalFailures <= 0) {
        tl.setResult(tl.TaskResult.Skipped, "No test failures found.")
        return
    }
    console.log(totalFailures + " tests failed. Will proceed with screenshot upload.")
    failedTests.forEach(async (failedTest: TestCaseResult, index) => {
        let testName = failedTest.automatedTestName ?? '';
        let className = failedTest.automatedTestStorage;
        let imgPath = getScreenshotFolder() + className + "/" + filenamify(testName) + ".png";//TODO make it configurable in upcoming version
        tl.debug("Searching for image at path: " + imgPath);
        if (fs.existsSync(imgPath)) {
            let imageAsBase64 = fs.readFileSync(imgPath, 'base64');
            let attachment: TestAttachmentRequestModel = {fileName: testName + ".png", stream: imageAsBase64};
            
            let testRunIdStr : string = failedTest?.testRun?.id ?? '-1';

            if(testRunIdStr == '-1') {
                tl.debug('Unable to get testRun.id');
                return;
            }

            apiCalls.push(testApi.createTestResultAttachment(attachment, project, +testRunIdStr, failedTest.id!));
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
    if (isNullEmptyOrUndefined(screenshotFolder)) {
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
    if (isNullEmptyOrUndefined(organization)) {
        throw Error("Organization is mandatory")
    } else {
        return organization
    }
}

/**
 * Test the given parameter to see if it's usable.
 * 
 * @param obj the obj to test
 * @returns true if the param is neither either null, empty, or undefined
 */
function isNullEmptyOrUndefined(obj: any): boolean {
    return obj === null || obj === '' || obj === undefined
}