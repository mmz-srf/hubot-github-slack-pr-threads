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


module.exports = function (robot) {

    robot.router.post("/hubot/gh-pull-requests", function (req, res) {

        let query = querystring.parse(url.parse(req.url).query)
        let room = query.room;

        try {

            let hubSignature = req.headers["x-hub-signature"]; //X-Hub-Signature
            let payload = req.body;
            let message = handlePullRequest(payload);

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
            } else {

                if (message) {
                    let brainKey = getBrainKey(payload);

                    let parentTs = robot.brain.get(brainKey);
                    if (robot.brain.get(brainKey)) {
                        message.thread_ts = parentTs;
                    }

                    if (message) {

                        if (robot.messageRoom(room, message)[0] !== undefined) {
                            robot.messageRoom(room, message)[0].then(data => {
                                if (!parentTs) {
                                    robot.brain.set(brainKey, data.ts);
                                }
                            });
                        } else {
                            console.error('ERROR: There is problem with the messageRoom. Was the Slack integration successful?')
                        }

                    }
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

function getBrainKey(data) {
    if (data.pull_request) {
        return "github-" + data.pull_request.html_url;
    }

    if (data.issue) {
        return "github-" + data.issue.html_url;
    }
}

function handlePullRequest(data) {
    // Open
    if (data.action === "opened" && data.pull_request) {
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
                    "author_link": data.pull_request.user.url,
                    "author_icon": data.pull_request.user.avatar_url,
                    "text": data.pull_request.body,
                    "color": "#7CD197"
                }
            ]
        };
    }

    // Comment
    if (data.action === "created" && data.comment && data.issue) {
        let number = data.issue.number;
        let url = data.comment.html_url;

        return {
            attachments: [
                {
                    "fallback": `PR #${number}: ${data.comment.user.login}: ${data.comment.body}`,
                    "title_link": url,
                    "author_name": data.comment.user.login,
                    "author_link": data.comment.user.url,
                    "author_icon": data.comment.user.avatar_url,
                    "text": data.comment.body
                }
            ]
        };
    }

    // Close, Merge, Reopen
    if (data.pull_request && ["closed", "reopened"].indexOf(data.action) > -1) {
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
                    "author_link": data.sender.url,
                    "author_icon": data.sender.avatar_url,
                    "color": "#d011dd"
                }
            ]
        };
    }

    if (process.env.HUBOT_GITHUB_SLACK_PR_THREADS_DEBUG) {
      console.log(`POST hubot/gh-pull-requests: /${data}`);
    }
}
