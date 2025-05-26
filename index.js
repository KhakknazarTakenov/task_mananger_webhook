import express from 'express';
import cors from 'cors';
import path from 'path';
import dotenv from 'dotenv';
import bodyParser from "body-parser";
import fs from 'fs';

import { logMessage } from "./utils/logger.js";
import { encryptText, decryptText, generateCryptoKeyAndIV } from "./utils/crypto.js";

import './global.js'

const envPath = path.join(process.cwd(), '.env');
dotenv.config({ path: envPath });

const BASE_URL = "/task_manager_webhook/";

const PORT = 3678;

const app = express();
app.use(cors({
    origin: "*"
}));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));

const departments = [
    {
        "ID": 3,
        "NAME": "Интеграторы",
        "KEY": "integrators"
    },
    {
        "ID": 154,
        "NAME": "Отдел программистов",
        "KEY": "programmers"
    },
    {
        "ID": 7,
        "NAME": "Отдел продаж",
        "KEY": "sales"
    }
]

const groups = [
    {
        "ID": 148,
        "NAME": "Интеграторы"
    },
    {
        "ID": 156,
        "NAME": "Программисты"
    },
    {
        "ID": 150,
        "NAME": "ОП_Переговоры и встречи"
    }
]

const getAllUsersFromDepartments = async () => {
    try {
        const bxLinkDecrypted = await decryptText(
            process.env.BX_LINK,
            process.env.CRYPTO_KEY,
            process.env.CRYPTO_IV
        );
        const departmentIds = departments.map((dep) => dep.ID);
        let allUsers = [];
        let start = 0;
        const batchSize = 50;

        while (true) {
            const deptFilter = departmentIds
                .map((id) => `filter[UF_DEPARTMENT][]=${id}`)
                .join('&');
            const response = await fetch(
                `${bxLinkDecrypted}/user.get?${deptFilter}&select[]=ID&select[]=NAME&select[]=UF_DEPARTMENT&start=${start}`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                }
            );
            const data = await response.json();

            if (!data.result || data.result.length === 0) {
                break;
            }

            allUsers = allUsers.concat(data.result);
            start += batchSize;

        }

        return allUsers;
    } catch (error) {
        logMessage(LOG_TYPES.E, 'getAllUsersFromDepartments', error);
        return null;
    }
};

const updateTask = async (taskId, payload) => {
    try {
        const bxLinkDecrypted = await decryptText(process.env.BX_LINK, process.env.CRYPTO_KEY, process.env.CRYPTO_IV);

        const response = await (await fetch(`${bxLinkDecrypted}/tasks.task.update?taskId=${taskId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        })).json();

        if (response.error) {
            throw new Error(response["error_description"]);
        }
        return true;
    } catch (error) {
        logMessage(LOG_TYPES.E, "updateTask", error);
        return false;
    }
}

app.post(BASE_URL + "init/", async (req, res) => {
    try {
        const bxLink = req.body.bx_link;
        if (!bxLink) {
            res.status(400).json({
                "status": false,
                "status_msg": "error",
                "message": "Необходимо предоставить ссылку входящего вебхука!"
            });
            return;
        }

        const keyIv = generateCryptoKeyAndIV();
        const bxLinkEncrypted = await encryptText(bxLink, keyIv.CRYPTO_KEY, keyIv.CRYPTO_IV);

        const bxLinkEncryptedBase64 = Buffer.from(bxLinkEncrypted, 'hex').toString('base64');

        const envPath = path.resolve(process.cwd(), '.env');
        const envContent = `CRYPTO_KEY=${keyIv.CRYPTO_KEY}\nCRYPTO_IV=${keyIv.CRYPTO_IV}\nBX_LINK=${bxLinkEncryptedBase64}\n`;

        fs.writeFileSync(envPath, envContent, 'utf8');

        res.status(200).json({
            "status": true,
            "status_msg": "success",
            "message": "Система готова работать с вашим битриксом!",
        });
    } catch (error) {
        logMessage(LOG_TYPES.E, BASE_URL + "init", error);
        res.status(500).json({
            "status": false,
            "status_msg": "error",
            "message": "Server error"
        });
    }
});

app.post(BASE_URL + "move_task_in_project/", async (req, res) => {
    try {
        const taskId = req.query.ID || req.params.ID || req.body.ID;
        if (!taskId) {
            throw new Error("Task ID is not provided");
        }

        const bxLinkDecrypted = await decryptText(process.env.BX_LINK, process.env.CRYPTO_KEY, process.env.CRYPTO_IV);

        const users = await getAllUsersFromDepartments();

        const task = await (await fetch(`${bxLinkDecrypted}/tasks.task.get?taskId=${taskId}&select[]=ID&select[]=TITLE&select[]=RESPONSIBLE_ID&select[]=DEADLINE&select[]=CHECKLIST&select[]=GROUP_ID&select[]=UF_AUTO_554734207359&select[]=UF_AUTO_899417333101&select[]=UF_AUTO_903852263140`,{
            method: "POST",
                headers: { "Content-Type": "application/json" },
        })).json();
        if (!task.result || task.result.length <= 0) {
            throw new Error(`Task with ID ${taskId} not found`);
        }
        const taskData = task.result["task"];

        const taskResponsibleUser = users.find((user) => Number(user.ID) === Number(taskData["responsibleId"]));

        let payload = null;
        let groupId = 0;

        if (taskData["ufAuto903852263140"] && (taskData["ufAuto903852263140"] === "Y" || taskData["ufAuto903852263140"] === "1" || taskData["ufAuto903852263140"] === 1)) {
            payload = {
                fields: {
                    GROUP_ID: 150
                },
            };
            groupId = 150;
        } else {
            if (!taskResponsibleUser) {
                throw new Error(`No user in allowed departments - ${task["responsibleId"]}`);
            }

            groupId = taskResponsibleUser["UF_DEPARTMENT"].includes(154)
                ? 156
                : taskResponsibleUser["UF_DEPARTMENT"].includes(3)
                    ? 148
                    : null;

            if (!groupId || groupId === 0) {
                throw new Error(`User ${taskResponsibleUser.ID} - ${taskResponsibleUser.NAME} is not in Integrators or Programmers departments`)
            }

            payload = {
                fields: {
                    GROUP_ID: groupId
                },
            };
        }

        if (!payload) {
            throw new Error("Payload was not filled!")
        }

        const response = await updateTask(taskId, payload);

        if (!response) {
            throw new Error(`Error occured while updating task ${taskId}`);
        }

        logMessage(LOG_TYPES.I, BASE_URL + "move_task_in_project", `Task ${taskId} - ${taskData.title} added to group - ${groupId} ${groups.find(group => Number(group.ID) === groupId ).NAME}`)
        res.send(response)

    } catch (error) {
        logMessage(LOG_TYPES.E, BASE_URL + "move_task_in_project", error);
        res.status(500).json({
            "status": false,
            "status_msg": "error",
            "message": "Server error"
        });
    }
})

app.listen(PORT, () => {
    console.log(`App is running on port ${PORT}`)
})