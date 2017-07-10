"use strict";

/**
 * Description:
 *   A Hubot script that keeps PRs (and updates like comments) in one Slack thread.
 *
 * Dependencies:
 *   None
 *
 * Configuration:
 *   HUBOT_GITHUB_SLACK_PR_THREADS_SECRET - secret configured at GitHub
 *   HUBOT_GITHUB_SLACK_PR_THREADS_USER - user with readonly access to the repos
 *   HUBOT_GITHUB_SLACK_PR_THREADS_PW - pw for the user with readonly access to the repos
 *   HUBOT_GITHUB_SLACK_PR_THREADS_DEBUG - log webhook data to console (default: false)
 *
 * Commands:
 *   none
 *
 * Author:
 *   Marek Ventur <marekventur@gmail.com>
 *   Conrad Peyer <conrad.peyer@srf.ch>
 *
 **/

const url = require("url");
const querystring = require("querystring");
const crypto = require('crypto')
const request = require("request")
const gitHubSerachUri = "https://api.github.com/search/issues?q="
const gitHubBasicAuth = "Basic " + new Buffer(process.env.HUBOT_GITHUB_SLACK_PR_THREADS_USER + ":" + process.env.HUBOT_GITHUB_SLACK_PR_THREADS_PW).toString("base64")

module.exports = function (robot) {

    robot.router.post("/hubot/gh-pull-requests", function (req, res) {

        let query = querystring.parse(url.parse(req.url).query)
        let room = query.room;

        try {

            let hubSignature = req.headers["x-hub-signature"]; //X-Hub-Signature
            let gitHubEvent = req.headers["x-github-event"]; //X-GitHub-Event
            let payload = req.body;

            if (hubSignature === undefined) {
                let errMsg = 'ERROR: GitHub Secret not set. Rejecting request!';
                console.error(errMsg)
                res.status(401).end(errMsg);
            } else if (!validate(hubSignature, payload)) {
                let errMsg = 'ERROR: GitHub Secret invalid. Rejecting request!';
                console.error(errMsg)
                res.status(401).end(errMsg);
            } else if (room === undefined) {
                let errMsg = 'ERROR: No room was defined. Please pass the parameter "room"!';
                console.error(errMsg)
                res.status(400).end(errMsg);
            } else if (gitHubEvent === undefined) {
                let errMsg = 'ERROR: Missing the GitHub event id from header "X-GitHub-Event"!';
                console.error(errMsg)
                res.status(400).end(errMsg);
            } else {
                let message = handlePullRequest(gitHubEvent, payload);

                if (message) {
                    getBrainKey(payload, function (brainKey) {

                        console.log('brainKey', brainKey)

                        let parentTs = robot.brain.get(brainKey);
                        if (robot.brain.get(brainKey)) {
                            message.thread_ts = parentTs;
                        }

                        if (message) {

                            let sentMsg = robot.messageRoom(room, message)[0];
                            if (sentMsg !== undefined) {
                                sentMsg.then(data => {
                                    if (!parentTs) {
                                        robot.brain.set(brainKey, data.ts);
                                    }
                                });
                            } else {
                                console.error('ERROR: There is problem with the messageRoom. Was the Slack integration successful?')
                            }

                        }
                    });
                }

                res.end("");

            }

        } catch (error) {
            console.log("github pull request notifier error: " + error + ". Request: " + req.body)
            res.end("");
        }
    });
};

function validate(signature, body) {
    /*
     https://developer.github.com/v3/repos/hooks/#create-a-hook:
     The value of this header is computed as the HMAC hex digest of the body, using the secret as the key.
     */

    let appSecret = process.env.HUBOT_GITHUB_SLACK_PR_THREADS_SECRET;
    if (appSecret === undefined) {
        console.error("ERROR: Secret not set! Please specify HUBOT_GITHUB_SLACK_PR_THREADS_SECRET.");
        return false
    } else {
        let hmac = "sha1=" + crypto.createHmac('sha1', appSecret).update(JSON.stringify(body)).digest('hex')
        return signature === hmac
    }
}

function getBrainKey(data, callback) {
    if (data.pull_request) {
        callback("github-" + data.pull_request.html_url);
    }

    if (data.issue) {
        callback("github-" + data.issue.html_url);
    }

    if (data.sha) {
        getGitHubPrBySha(data.sha, callback);
    }
}

function getGitHubPrBySha(sha, callback) {

    //Search for a PR at GitHub
    request({
        url: gitHubSerachUri + sha,
        json: true,
        headers : {
            'User-Agent': 'hubot-github-slack-pr-threads',
            'Authorization' : gitHubBasicAuth
        }
    }, function (error, response, bodyAsJson) {

        if (!error && response.statusCode === 200) {

            if (bodyAsJson.items.length !== 0) {
                //reduce to the last PR
                let latestPr = bodyAsJson.items.reduce(function(prev, current) {
                    return (prev.number > current.number) ? prev : current
                })
                callback(latestPr.html_url);
            } else {
                callback(sha);
            }

        } else {
            console.error(response.statusCode, response.statusMessage)
            callback(sha);
        }

    })

}

function handlePullRequest(eventType, data) {

    if (["pull_request", "pull_request_review", "pull_request_review_comment"].indexOf(eventType) > -1) {

        if (["closed", "reopened"].indexOf(data.action) > -1) {
            let number = data.pull_request.number;
            let url = data.pull_request.html_url;

            let action = data.action;
            if (action === "closed" && data.pull_request.merged) {
                action = "merged";
            }

            return {
                attachments: [
                    {
                        "fallback": `PR #${number}: ${action}`,
                        "title": `${action.toUpperCase()}`,
                        "title_link": url,
                        "author_name": data.sender.login,
                        "author_link": data.sender.html_url,
                        "author_icon": data.sender.avatar_url,
                        "color": "#d011dd"
                    }
                ]
            };
        } else {

            let number = data.pull_request.number;
            let url = data.pull_request.html_url;
            let title = data.pull_request.title;

            return {
                attachments: [
                    {
                        "fallback": `PR #${number}: ${title} - ${url}`,
                        "title": `PR #${number}: ${title}`,
                        "title_link": url,
                        "author_name": data.pull_request.user.login,
                        "author_link": data.pull_request.user.html_url,
                        "author_icon": data.pull_request.user.avatar_url,
                        "text": data.pull_request.body,
                        "color": "#7CD197"
                    }
                ]
            };

        }

    } else if (eventType === "issue_comment") {

        let number = data.issue.number;
        let url = data.comment.html_url;

        return {
            attachments: [
                {
                    "fallback": `PR #${number}: ${data.comment.user.login}: ${data.comment.body}`,
                    "title_link": url,
                    "author_name": data.comment.user.login,
                    "author_link": data.comment.user.html_url,
                    "author_icon": data.comment.user.avatar_url,
                    "text": data.comment.body
                }
            ]
        };

    } else if (eventType === "status") {

        if (data.target_url === "") {
            return {
                attachments: [
                    {
                        "fallback": `${data.description} ${data.commit.html_url} (${data.state})`,
                        "title": data.description,
                        "author_name": data.commit.commit.author.name,
                        "author_link": data.commit.committer.html_url,
                        "author_icon": data.commit.committer.avatar_url,
                        "text": `${data.commit.html_url} (${data.state})`,
                        "color": stateToColor(data.state)
                    }
                ]
            };
        } else if (data.target_url !== "") {
            return {
                attachments: [
                    {
                        "fallback": `${data.description} ${data.target_url}`,
                        "title": data.description,
                        "author_name": data.commit.commit.author.name,
                        "author_link": data.commit.committer.html_url,
                        "author_icon": data.commit.committer.avatar_url,
                        "text": `${data.target_url} (${data.state})`,
                        "color": stateToColor(data.state)
                    }
                ]
            };
        }

    } else {
        console.warn("Don't understand event type [" + eventType + "]");
    }

    if (process.env.HUBOT_GITHUB_SLACK_PR_THREADS_DEBUG) {
        console.log('POST hubot/gh-pull-requests:', data);
    }
}

function stateToColor(state) {
    if (state === "pending") {
        return "#ffffcc";
    } else if (state === "error") {
        return "#ff8080";
    } else if (state === "success") {
        return "#b3ffcc";
    } else if (state === "failure") {
        return "#ff9900";
    } else {
        return ""
    }
}