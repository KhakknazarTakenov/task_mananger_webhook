import express from 'express';
import cors from 'cors';
import path from 'path';
import dotenv, {parse} from 'dotenv';
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
        "NAME": "Интеграторы"
    },
    {
        "ID": 154,
        "NAME": "Отдел программистов"
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
]

const getAllUsersFromDepartments = async () => {
    try {
        const bxLinkDecrypted = await decryptText(
            process.env.BX_LINK,
            process.env.CRYPTO_KEY,
            process.env.CRYPTO_IV
        );
        const departmentIds = departments.map((dep) => dep.ID); // Извлекаем только ID
        let allUsers = [];
        let start = 0;
        const batchSize = 50;

        while (true) {
            // Формируем строку для фильтра UF_DEPARTMENT
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
                break; // Выходим, если больше нет пользователей
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
        logMessage(LOG_TYPES.E, BASE_URL + "/init", error);
        res.status(500).json({
            "status": false,
            "status_msg": "error",
            "message": "Server error"
        });
    }
});

app.post(BASE_URL + "move_task_in_project/", async (req, res) => {
    try {
        const taskId = req.body["data[FIELDS_AFTER][ID]"] || req.query.ID || req.params.ID || req.body.ID;
        if (!taskId) {
            throw new Error("Task ID is not provided");
        }

        const bxLinkDecrypted = await decryptText(process.env.BX_LINK, process.env.CRYPTO_KEY, process.env.CRYPTO_IV);

        const users = await getAllUsersFromDepartments();

        const task = await (await fetch(`${bxLinkDecrypted}/tasks.task.get?taskId=${taskId}&select[]=ID&select[]=TITLE&select[]=RESPONSIBLE_ID&select[]=DEADLINE&select[]=CHECKLIST&select[]=GROUP_ID&select[]=UF_AUTO_554734207359&select[]=UF_AUTO_899417333101`,{
            method: "POST",
                headers: { "Content-Type": "application/json" },
        })).json();
        if (!task.result || task.result.length <= 0) {
            throw new Error(`Task with ID ${taskId} not found`);
        }
        const taskData = task.result.task;

        const taskResponsibleUser = users.find((user) => Number(user.ID) === Number(taskData.responsibleId));

        const groupId = taskResponsibleUser.UF_DEPARTMENT.includes(154)
            ? 156
            : taskResponsibleUser.UF_DEPARTMENT.includes(3)
                ? 148
                : null;

        if (!groupId || groupId === 0) {
            throw new Error(`User ${taskResponsibleUser.ID} - ${taskResponsibleUser.NAME} is not in Integrators or Programmers departments`)
        }

        if (taskData.ufAuto899417333101 === taskResponsibleUser.ID) {
            logMessage(LOG_TYPES.A, BASE_URL+ '/move_task_in_project', `Same responsible for task ${taskId}`);
            if (Number(taskData.ufAuto554734207359) !== Number(taskData.groupId)) {
                const payload = {
                    fields: {
                        UF_AUTO_554734207359: taskData.groupId,
                    },
                };

                const response = await (await fetch(`${bxLinkDecrypted}/tasks.task.update?taskId=${taskId}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload),
                })).json();

                if (response.error) {
                    throw new Error(response.error_description);
                }

                logMessage(LOG_TYPES.I, BASE_URL + "/move_task_in_project", `Task ${taskId} - ${taskData.title} added to group - ${groupId} within same responsible employee`)
                res.send(response)
            }
            res.send();
            return;
        } else if (taskData.ufAuto554734207359
            && taskData.ufAuto554734207359 !== ""
            && (Number(taskData.groupId) === Number(taskData.ufAuto554734207359))
            && groupId === Number(taskData.groupId)
        ) {
            logMessage(LOG_TYPES.A, BASE_URL+ '/move_task_in_project', `Task ${taskId} is already in project - ${taskData.ufAuto554734207359} - ${taskData.groupId} - ${groups.find(group => Number(group.ID) === Number(taskData.groupId)).NAME}`);
            res.send();
            return;
        }

        const payload = {
            fields: {
                GROUP_ID: groupId,                // ID проекта
                UF_AUTO_554734207359: groupId,    // Предыдущая группа
                UF_AUTO_899417333101: taskResponsibleUser.ID // Предыдущий ответственный
            },
        };

        const response = await (await fetch(`${bxLinkDecrypted}/tasks.task.update?taskId=${taskId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        })).json();

        if (response.error) {
            throw new Error(response.error_description);
        }

        logMessage(LOG_TYPES.I, BASE_URL + "/move_task_in_project", `Task ${taskId} - ${taskData.title} added to group - ${groupId}`)
        res.send(response)

    } catch (error) {
        logMessage(LOG_TYPES.E, BASE_URL + "/move_task_in_project", error);
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