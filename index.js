import {
  AutoScalingClient,
  DescribeAutoScalingInstancesCommand,
  SetDesiredCapacityCommand,
  TerminateInstanceInAutoScalingGroupCommand,
} from "@aws-sdk/client-auto-scaling";
import {
  DescribeInstancesCommand,
  EC2Client,
  ListImagesInRecycleBinCommand,
} from "@aws-sdk/client-ec2";

import express from "express";

const client = new AutoScalingClient({
  region: "ap-south-1",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY,
    secretAccessKey: process.env.AWS_ACCESS_SECRET,
  },
});

const ec2Client = new EC2Client({
  region: "ap-south-1",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY,
    secretAccessKey: process.env.AWS_ACCESS_SECRET,
  },
});

const app = express();
app.use(express.json());

const MACHINES = []; //[{id:string, isUsed:boolean, assignProject?:string}]
const refreshInstances = async function () {
  const command = new DescribeAutoScalingInstancesCommand();
  const data = await client.send(command);

  const instanceIds = data.AutoScalingInstances?.map((x) => x.InstanceId) ?? [];
  if (instanceIds.length === 0) {
    MACHINES.length = 0;
    return;
  }

  const ec2InstanceCommand = new DescribeInstancesCommand({
    InstanceIds: instanceIds,
  });
  const ec2Response = await ec2Client.send(ec2InstanceCommand);

  // add the instance the data in MACHINES & remove the instance that have die
  const liveMachines = ec2Response.Reservations.flatMap((r) => r.Instances).map(
    (instance) => {
      const known = MACHINES.find((x) => x.id === instance.InstanceId);
      return {
        id: instance.InstanceId,
        ip: instance.PublicDnsName,
        isUsed: known ? known.isUsed : false,
        assignProject: known ? known.assignProject : undefined,
      };
    },
  );

  MACHINES.length = 0;
  MACHINES.push(...liveMachines);
};
refreshInstances();

setInterval(() => {
  refreshInstances();
}, 10 * 1000);

app.get("/:projectId", async (req, res) => {
  const projectId = req.params.projectId;
  const idleMachine = MACHINES.find((x) => x.isUsed === false);
  if (!idleMachine) {
    return res.status(404).send("No idle machine found");
  }

  idleMachine.isUsed = true;
  idleMachine.assignProject = projectId;

  // scale up the infra
  const command = new SetDesiredCapacityCommand({
    AutoScalingGroupName: "vscode",
    DesiredCapacity:
      MACHINES.length + (5 - MACHINES.filter((x) => x.isUsed === false).length),
  });
  client.send(command);

  res.send({ ip: idleMachine.ip });
});

app.post("/destroy", async (req, res) => {
  const machineId = req.body.machineId;

  const command = new TerminateInstanceInAutoScalingGroupCommand({
    InstanceId: machineId,
    ShouldDecrementDesiredCapacity: true,
  });
  await client.send(command);

  const index = MACHINES.findIndex((x) => x.id === machineId);
  if (index !== -1) {
    MACHINES.splice(index, 1);
  }

  res.send({ ok: true });
});

app.listen(3000);
